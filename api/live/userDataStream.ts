import type { PrivateWsHealth } from "@contracts/trading";
import { privateUserDataStreamUrl, type BinanceAccountResponse } from "./binanceSigned";
import { compareDecimals, decimal } from "./decimal";
import { type ReconciliationIssueCategory, type ReconciliationStore } from "./reconciliation";
import type {
  LiveFill,
  LiveOrder,
  LiveOrderStatus,
  LiveOrderStore,
  LivePositionSeed,
  OrderStateMachine,
} from "./orderStateMachine";

export interface UserDataSocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface UserDataClient {
  createListenKey(): Promise<{ listenKey: string }>;
  keepAliveListenKey(): Promise<Record<string, never>>;
  closeListenKey(): Promise<Record<string, never>>;
  syncServerTime(): Promise<void>;
  account(): Promise<BinanceAccountResponse>;
}

interface UserDataStreamOptions {
  client: UserDataClient;
  socketFactory: (url: string) => UserDataSocket;
  machine: OrderStateMachine;
  orders: LiveOrderStore;
  store: ReconciliationStore;
  seedFor: (order: LiveOrder) => Promise<LivePositionSeed>;
  loadIntentMetadata: (order: LiveOrder) => Promise<Pick<LivePositionSeed, "signalId" | "strategyType" | "breakoutPrice">>;
  reconcile: () => Promise<{ ok: boolean }>;
  pauseNewEntries: () => Promise<void>;
  keepAliveIntervalMs?: number;
  reconnectDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid user-data event");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Missing ${field}`);
  const result = String(value);
  if (!result) throw new Error(`Missing ${field}`);
  return result;
}

function eventTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid event time");
  return value;
}

function orderStatus(value: unknown): LiveOrderStatus {
  switch (value) {
    case "NEW": return "NEW";
    case "PARTIALLY_FILLED": return "PARTIALLY_FILLED";
    case "FILLED": return "FILLED";
    case "CANCELED":
    case "EXPIRED":
    case "REJECTED": return "CANCEL";
    default: throw new Error("Unsupported exchange order status");
  }
}

const STATUS_RANK: Record<LiveOrderStatus, number> = {
  PENDING_SEND: 0,
  SUBMITTING: 1,
  NEW: 2,
  PARTIALLY_FILLED: 3,
  FILLED: 4,
  CANCEL: 4,
  REPLACE: 4,
  UNKNOWN: 5,
  RECONCILING: 5,
};

interface StreamAttempt {
  generation: number;
  socket: UserDataSocket | null;
  bufferedEvents: unknown[];
  reconciling: boolean;
}

class ReconciliationNotReady extends Error {}

export class UserDataStream {
  private attempt: StreamAttempt | null = null;
  private reconnecting: Promise<void> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private generation = 0;
  private running = false;
  private lastMessageAt: number | null = null;
  private reconnects = 0;
  private readonly keepAliveIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly options: UserDataStreamOptions;

  constructor(options: UserDataStreamOptions) {
    this.options = options;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? 30 * 60_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  health(): PrivateWsHealth {
    return {
      configured: true,
      running: this.running,
      connected: this.running && this.attempt?.socket != null && !this.attempt.reconciling,
      lastMessageAt: this.lastMessageAt,
      reconnects: this.reconnects,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.reconnecting = null;
    const generation = ++this.generation;
    await this.options.pauseNewEntries();
    try {
      await this.connectWithRetry(generation, false);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.running = false;
      this.generation += 1;
      this.discardAttempt();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.options.pauseNewEntries();
    this.generation += 1;
    this.reconnecting = null;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.discardAttempt();
    await this.eventTail;
    await this.options.client.closeListenKey();
  }

  async keepAlive(): Promise<void> {
    if (!this.running) return;
    try {
      await this.options.client.keepAliveListenKey();
    } catch {
      await this.reconnect();
    }
  }

  private isCurrent(generation: number): boolean {
    return this.running && this.generation === generation;
  }

  private isCurrentAttempt(attempt: StreamAttempt): boolean {
    return this.isCurrent(attempt.generation) && this.attempt === attempt;
  }

  private discardAttempt(): void {
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt?.socket) return;
    attempt.socket.onclose = null;
    attempt.socket.onerror = null;
    attempt.socket.onmessage = null;
    attempt.socket.close();
    attempt.bufferedEvents = [];
  }

  private async connectWithRetry(generation: number, retryErrors: boolean): Promise<void> {
    let failures = 0;
    while (this.isCurrent(generation)) {
      try {
        await this.connectAndReconcile(generation);
        return;
      } catch (error) {
        if (!this.isCurrent(generation)) return;
        this.discardAttempt();
        if (!retryErrors && !(error instanceof ReconciliationNotReady)) throw error;
        await this.recordIssue("REST_RECONCILIATION", null, "私有流连接或 REST 对账未就绪，保持冻结并重试");
        const delay = Math.min(this.reconnectDelayMs * 2 ** Math.min(failures, 5), 30_000);
        failures += 1;
        await this.sleep(delay);
      }
    }
  }

  private async connectAndReconcile(generation: number): Promise<void> {
    const attempt: StreamAttempt = { generation, socket: null, bufferedEvents: [], reconciling: true };
    this.attempt = attempt;
    const { listenKey } = await this.options.client.createListenKey();
    if (!this.isCurrentAttempt(attempt)) return;
    if (!listenKey) throw new Error("Empty listenKey");
    const socket = this.options.socketFactory(privateUserDataStreamUrl(listenKey));
    attempt.socket = socket;
    socket.onmessage = ({ data }) => {
      if (!this.isCurrentAttempt(attempt)) return;
      if (attempt.reconciling) attempt.bufferedEvents.push(data);
      else this.enqueue(data, attempt);
    };
    socket.onclose = () => {
      if (this.isCurrentAttempt(attempt)) void this.reconnect();
    };
    socket.onerror = () => {
      if (this.isCurrentAttempt(attempt)) void this.reconnect();
    };
    await this.options.client.syncServerTime();
    if (!this.isCurrentAttempt(attempt)) return;
    const result = await this.options.reconcile();
    if (!this.isCurrentAttempt(attempt)) return;
    if (!result.ok) throw new ReconciliationNotReady("REST reconciliation is not ready");
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => { void this.keepAlive(); }, this.keepAliveIntervalMs);
    attempt.reconciling = false;
    const buffered = attempt.bufferedEvents;
    attempt.bufferedEvents = [];
    for (const event of buffered) this.enqueue(event, attempt);
  }

  private enqueue(data: unknown, attempt: StreamAttempt): void {
    this.eventTail = this.eventTail.then(async () => {
      if (this.isCurrentAttempt(attempt)) await this.handle(data);
    }).catch(async () => {
      if (!this.isCurrentAttempt(attempt)) return;
      await this.options.pauseNewEntries();
      await this.recordIssue("USER_DATA_EVENT", null, "私有事件无效或处理失败，冻结并重新对账");
      await this.reconnect();
    });
  }

  private async handle(data: unknown): Promise<void> {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    const event = object(parsed);
    this.lastMessageAt = typeof event.E === "number" && Number.isSafeInteger(event.E) ? event.E : this.now();
    if (event.e === "listenKeyExpired") {
      await this.reconnect();
      return;
    }
    if (event.e === "ORDER_TRADE_UPDATE") {
      await this.handleOrderEvent(event);
      return;
    }
    if (event.e === "ACCOUNT_UPDATE") await this.handleAccountEvent(event);
  }

  private async handleOrderEvent(event: Record<string, unknown>): Promise<void> {
    const update = object(event.o);
    const clientOrderId = requiredString(update.c, "client order ID");
    const local = await this.options.orders.getOrder(clientOrderId);
    if (!local) {
      await this.options.pauseNewEntries();
      await this.recordIssue("UNKNOWN_MANUAL_ORDER", typeof update.s === "string" ? update.s : null,
        `${clientOrderId} 是未知人工或外部订单事件，未接管`);
      return;
    }
    const lastQuantity = decimal(requiredString(update.l ?? "0", "last filled quantity"));
    if (compareDecimals(lastQuantity, "0") > 0) {
      const seed = await this.options.orders.getPosition(local.intentId) ?? await this.options.seedFor(local);
      const metadata = await this.options.loadIntentMetadata(local);
      const enrichedSeed: LivePositionSeed = {
        ...seed,
        signalId: metadata.signalId,
        strategyType: metadata.strategyType,
        breakoutPrice: metadata.breakoutPrice,
        exitPending: seed.exitPending ?? false,
      };
      const fill: LiveFill = {
        exchangeTradeId: requiredString(update.t, "trade ID"),
        exchangeOrderId: requiredString(update.i, "order ID"),
        symbol: requiredString(update.s, "symbol"),
        side: requiredString(update.S, "side") === "SELL" ? "SELL" : "BUY",
        price: decimal(requiredString(update.L, "last price")),
        quantity: lastQuantity,
        commission: decimal(requiredString(update.n ?? "0", "commission")),
        commissionAsset: requiredString(update.N, "commission asset"),
        realizedPnl: decimal(requiredString(update.rp ?? "0", "realized PnL")),
        isMaker: update.m === true,
        executedAt: eventTime(event.T ?? event.E),
      };
      const applied = await this.options.machine.handleFill(clientOrderId, fill, enrichedSeed);
      for (const unresolved of applied.unresolved ?? []) {
        await this.recordIssue("UNPROTECTED_POSITION", local.symbol, unresolved);
      }
    }
    const latest = await this.options.orders.getOrder(clientOrderId);
    if (!latest || ["UNKNOWN", "RECONCILING", "REPLACE"].includes(latest.status)) return;
    const status = orderStatus(update.X);
    if (STATUS_RANK[status] < STATUS_RANK[latest.status]) return;
    if (["FILLED", "CANCEL"].includes(latest.status) && status !== latest.status) return;
    await this.options.orders.transitionOrder(clientOrderId, [latest.status], {
      status,
      exchangeOrderId: requiredString(update.i, "order ID"),
    });
  }

  private async handleAccountEvent(event: Record<string, unknown>): Promise<void> {
    const time = eventTime(event.E);
    const update = object(event.a);
    if (!Array.isArray(update.B) || update.B.length === 0) throw new Error("Invalid account balances");
    const assets = update.B.map((value) => requiredString(object(value).a, "asset"));
    const latest = await this.options.store.latestAccountSnapshots();
    const byAsset = new Map(latest.map((snapshot) => [snapshot.asset, snapshot]));
    if (assets.every((asset) => (byAsset.get(asset)?.observedAt ?? -1) >= time)) return;
    const account = await this.options.client.account();
    for (const asset of account.assets) {
      await this.options.store.appendAccountSnapshot({
        asset: asset.asset,
        walletBalance: decimal(asset.walletBalance),
        availableBalance: decimal(asset.availableBalance),
        crossWalletBalance: decimal(asset.crossWalletBalance ?? asset.walletBalance),
        observedAt: time,
      });
    }
  }

  private async reconnect(): Promise<void> {
    if (!this.running) return;
    if (this.reconnecting) return this.reconnecting;
    this.reconnects += 1;
    const generation = ++this.generation;
    this.discardAttempt();
    const pending = (async () => {
      if (!this.isCurrent(generation)) return;
      await this.options.pauseNewEntries();
      if (!this.isCurrent(generation)) return;
      await this.sleep(this.reconnectDelayMs);
      await this.connectWithRetry(generation, true);
    })();
    this.reconnecting = pending;
    try {
      await pending;
    } finally {
      if (this.reconnecting === pending) this.reconnecting = null;
    }
  }

  private recordIssue(category: ReconciliationIssueCategory, symbol: string | null, message: string): Promise<unknown> {
    return this.options.store.recordIssue({
      category,
      severity: "CRITICAL",
      symbol,
      expectedValue: null,
      actualValue: null,
      message,
      detectedAt: this.now(),
    });
  }
}
