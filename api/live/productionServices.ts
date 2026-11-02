import { eq } from "drizzle-orm";
import { liveIntents, livePositions, tradingSettings } from "@db/schema";
import type { Opportunity } from "@contracts/trading";
import { getSettings as readSettings, settingsFromRow } from "../queries/trading";
import { log } from "../lib/logger";
import { BinanceSignedClient } from "./binanceSigned";
import { createLiveAdapter, createLiveAdmissionGuard, type ServerEnvironment } from "./liveConfig";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import { createMainnetLiveExecutionAdapter } from "./liveExecution";
import {
  getLiveIntentReservations,
  loadLiveIntentMetadata,
  type LiveDatabase,
  type LiveFinalGateResult,
  type LiveTransaction,
} from "./livePersistence";
import { runLivePreflight, type LivePreflightResult } from "./livePreflight";
import { calculateLivePositionRisk } from "./liveRisk";
import { addDecimals, compareDecimals, decimal, multiplyDecimals } from "./decimal";
import {
  DrizzleReconciliationStore,
  LiveEntryAdmission,
  ReconciliationService,
  type ReconciliationStore,
} from "./reconciliation";
import {
  DrizzleAccountingStore,
  LiveAccountingSynchronizer,
  type LiveAccountingStore,
} from "./accounting";
import type { LiveOrderStore, LivePositionSeed } from "./orderStateMachine";
import { UserDataStream, type UserDataSocket } from "./userDataStream";
import type { ProductionLiveServices } from "./productionRuntime";

export interface ProductionServicesOptions {
  env: ServerEnvironment;
  db: LiveDatabase;
  getSettings?: typeof readSettings;
  workerId?: string;
  client?: BinanceSignedClient;
  orderStore?: LiveOrderStore;
  reconciliationStore?: ReconciliationStore;
  accountingStore?: LiveAccountingStore;
  socketFactory?: (url: string) => UserDataSocket;
  now?: () => number;
  reconciliationIntervalMs?: number;
}

interface FreshPreflight {
  checkedAt: number;
  account: Awaited<ReturnType<BinanceSignedClient["account"]>>;
  result: Extract<LivePreflightResult, { ok: true }>;
}

function allowedSymbols(env: ServerEnvironment): string[] {
  return [...new Set((env.BINANCE_MAINNET_ALLOWED_SYMBOLS ?? "")
    .split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

function defaultSocket(url: string): UserDataSocket {
  if (typeof WebSocket === "undefined") throw new Error("Production WebSocket is unavailable");
  const socket = new WebSocket(url);
  return {
    set onmessage(handler: UserDataSocket["onmessage"]) {
      socket.onmessage = handler ? (event) => handler({ data: event.data }) : null;
    },
    set onclose(handler: UserDataSocket["onclose"]) { socket.onclose = handler; },
    set onerror(handler: UserDataSocket["onerror"]) { socket.onerror = handler; },
    close: () => socket.close(),
  };
}

export function createBinanceProductionLiveServices(options: ProductionServicesOptions): ProductionLiveServices {
  const now = options.now ?? Date.now;
  const getSettings = options.getSettings ?? readSettings;
  const symbols = allowedSymbols(options.env);
  const client = options.client ?? createLiveAdapter(
    options.env,
    (credentials) => new BinanceSignedClient(credentials),
  );
  const orders = options.orderStore ?? new DrizzleLiveOrderStore(options.db);
  const reconciliationStore = options.reconciliationStore ?? new DrizzleReconciliationStore(options.db);
  const accountingStore = options.accountingStore ?? new DrizzleAccountingStore(options.db);
  const admission = new LiveEntryAdmission(true);
  const fresh = new Map<string, FreshPreflight>();

  async function currentSeed(order: { intentId: string }): Promise<LivePositionSeed> {
    const rows = await options.db.select().from(liveIntents).where(eq(liveIntents.id, order.intentId)).limit(1);
    const intent = rows[0];
    if (!intent) throw new Error("Live position intent is missing");
    const bracketRows = await client.leverageBracket(intent.symbol);
    const brackets = bracketRows.find((row) => row.symbol === intent.symbol)?.brackets ?? [];
    const matching = brackets.filter((bracket) => compareDecimals(intent.notional, bracket.notionalFloor) >= 0
      && compareDecimals(intent.notional, bracket.notionalCap) <= 0);
    if (matching.length !== 1) throw new Error("Cannot restore a unique real maintenance bracket");
    const bracket = matching[0];
    return {
      id: intent.id,
      signalId: intent.signalId,
      strategyType: intent.strategyType === "MOMENTUM" ? "MOMENTUM" : "SWING",
      breakoutPrice: intent.breakoutPrice ?? undefined,
      symbol: intent.symbol,
      side: intent.side === "SHORT" ? "SHORT" : "LONG",
      stopPrice: intent.stopPrice,
      liquidationPrice: intent.liquidationPrice,
      leverage: String(intent.leverage),
      maintenanceBracket: bracket.bracket,
      maintMarginRatio: bracket.maintMarginRatio,
      cumMaintenance: bracket.cum,
    };
  }

  const assertCurrentAdmission = createLiveAdmissionGuard(options.env, () => preflight(), now);
  const adapter = createMainnetLiveExecutionAdapter({
    db: options.db,
    store: orders,
    gateway: client,
    workerId: options.workerId ?? `live-${process.pid}`,
    assertCurrentAdmission: async () => {
      if (!admission.allowed) throw new Error("私有流或对账已冻结主网新开仓");
      await assertCurrentAdmission();
    },
    alert: (message) => log.error("live execution alert", { message }),
    prepareIntent: (opportunity) => {
      const cached = fresh.get(opportunity.symbol);
      if (!cached || cached.checkedAt > now() || now() - cached.checkedAt > 10_000) {
        throw new Error("缺少新鲜的主网签名预检");
      }
      const actualLeverage = Number(cached.result.positionRisk.leverage);
      return {
        signalId: opportunity.signalId,
        symbol: opportunity.symbol,
        side: opportunity.side,
        quantity: "0",
        limitPrice: decimal(String(opportunity.limitPrice)),
        tickSize: cached.result.filters.tickSize,
        stopPrice: decimal(String(opportunity.stop)),
        liquidationPrice: cached.result.positionRisk.liquidationPrice,
        leverage: Number.isInteger(actualLeverage) ? actualLeverage : 0,
        notional: "0",
        reservedMargin: "0",
        reservedRisk: "0",
        expiresAt: new Date(opportunity.expiryTime),
        leaseDurationMs: 5_000,
      };
    },
    finalGate: async (opportunity: Opportunity, _input, tx: LiveTransaction, context): Promise<LiveFinalGateResult> => {
      const cached = fresh.get(opportunity.symbol);
      if (!cached || cached.checkedAt > now() || now() - cached.checkedAt > 10_000
        || opportunity.expiryTime <= now()) {
        return { approved: false, reason: "签名预检已陈旧或动量信号已过期" };
      }
      const settingsRow = (await tx.select().from(tradingSettings).where(eq(tradingSettings.id, 1)).limit(1))[0];
      if (!settingsRow) return { approved: false, reason: "缺少交易设置" };
      const settings = settingsFromRow(settingsRow);
      const asset = cached.account.assets.find((candidate) => candidate.asset === "USDT");
      if (!asset) return { approved: false, reason: "缺少真实 USDT 余额" };
      const [positions, pendingIntents] = await Promise.all([
        tx.select().from(livePositions).where(eq(livePositions.status, "OPEN")),
        getLiveIntentReservations(tx),
      ]);
      const existingPositionMargin = positions.length
        ? addDecimals(...positions.map((position) => position.isolatedWallet)) : "0";
      const existingExposure = positions.length
        ? addDecimals(...positions.map((position) => multiplyDecimals(position.quantity, position.entryPrice))) : "0";
      const risk = calculateLivePositionRisk({
        side: opportunity.side,
        walletBalance: asset.walletBalance,
        availableBalance: asset.availableBalance,
        entryPrice: decimal(String(opportunity.limitPrice)),
        stopPrice: decimal(String(opportunity.stop)),
        liquidationPrice: cached.result.positionRisk.liquidationPrice,
        actualLeverage: cached.result.positionRisk.leverage,
        leverageMode: settings.leverageMode,
        fixedLeverage: settings.fixedLeverage,
        riskPerTradePct: settings.riskPerTradePct,
        mode: context.mode,
        highVolatilityRiskMultiplier: context.highVolatilityRiskMultiplier,
        marginPerTradePct: settings.marginPerTradePct,
        totalMarginCapPct: settings.totalMarginCapPct,
        takerFeeBps: settings.takerFeeBps,
        slippageBps: settings.slippageBps,
        stepSize: cached.result.filters.stepSize,
        minQuantity: cached.result.filters.minQuantity,
        minNotional: cached.result.filters.minNotional,
        brackets: cached.result.brackets,
        pendingIntents: [pendingIntents],
        existingPositionMargin,
        existingExposure,
      });
      if (!risk.ok) return { approved: false, reason: risk.reason };
      return {
        approved: true,
        signalId: opportunity.signalId,
        quantity: risk.quantity,
        notional: risk.notional,
        reservedMargin: risk.initialMargin,
        reservedRisk: risk.estimatedRisk,
        validUntil: new Date(Math.min(opportunity.expiryTime, now() + 5_000)),
      };
    },
  });

  const accounting = new LiveAccountingSynchronizer({
    client,
    store: accountingStore,
    incomeParams: {},
    symbols,
  });
  const reconciliationService = new ReconciliationService({
    client,
    orders,
    store: reconciliationStore,
    recovery: adapter.machine,
    accounting,
    pauseNewEntries: () => admission.pauseForReconciliation(),
    now,
  });
  let running = false;
  let lastRunAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const reconcile = async () => {
    const result = await reconciliationService.reconcile();
    lastRunAt = now();
    return result;
  };
  const stream = new UserDataStream({
    client,
    socketFactory: options.socketFactory ?? defaultSocket,
    machine: adapter.machine,
    orders,
    store: reconciliationStore,
    seedFor: currentSeed,
    loadIntentMetadata: (order) => loadLiveIntentMetadata(options.db, order),
    reconcile,
    pauseNewEntries: () => admission.suspend(),
    now,
  });

  async function preflight() {
    const checkedAt = now();
    if (symbols.length === 0) {
      return { ready: false, reasons: ["BINANCE_MAINNET_ALLOWED_SYMBOLS 未配置"], checkedAt: null };
    }
    try {
      const settings = await getSettings();
      const [account, issues, ownedOrders, managedPositions] = await Promise.all([
        client.account(),
        reconciliationStore.listIssues(),
        orders.listOrders(),
        orders.listOpenPositions(),
      ]);
      const results = await Promise.all(symbols.map((symbol) => runLivePreflight({
        client,
        symbol,
        allowedSymbols: symbols,
        leverageMode: settings.leverageMode,
        fixedLeverage: settings.fixedLeverage,
        reconciliationIssues: issues,
        ownedClientOrderIds: ownedOrders.map((order) => order.clientOrderId),
        managedPositionSymbols: managedPositions.map((position) => position.symbol),
      })));
      const reasons = results.flatMap((result) => result.ok ? [] : result.reasons);
      results.forEach((result, index) => {
        if (result.ok) fresh.set(symbols[index], { checkedAt, account, result });
        else fresh.delete(symbols[index]);
      });
      const ws = stream.health();
      const wsFresh = ws.lastMessageAt !== null && ws.lastMessageAt <= now() && now() - ws.lastMessageAt <= 10_000;
      if (!ws.running || !ws.connected || !wsFresh) reasons.push("私有 WS 未连接或消息不新鲜");
      if (!running || lastRunAt === null || lastRunAt > now() || now() - lastRunAt > 10_000) {
        reasons.push("REST 对账未运行或已陈旧");
      }
      if (issues.some((issue) => issue.status !== "RESOLVED" && ["ERROR", "CRITICAL"].includes(issue.severity))) {
        reasons.push("存在未解决的严重对账问题");
      }
      return { ready: reasons.length === 0, reasons: [...new Set(reasons)], checkedAt: new Date(checkedAt).toISOString() };
    } catch {
      fresh.clear();
      return { ready: false, reasons: ["主网签名预检失败"], checkedAt: null };
    }
  }

  return {
    adapter,
    preflight,
    privateWs: stream,
    reconciliation: { health: () => ({ configured: true, running, lastRunAt }) },
    async start() {
      if (running) return;
      await stream.start();
      running = true;
      if (lastRunAt === null) lastRunAt = now();
      const interval = options.reconciliationIntervalMs ?? 5_000;
      timer = setInterval(() => { void reconcile(); }, interval);
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      await admission.pauseFromOperator();
      await stream.stop();
      fresh.clear();
    },
  };
}
