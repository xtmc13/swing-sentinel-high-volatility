import { and, asc, desc, eq, like, ne, notInArray, sql } from "drizzle-orm";
import { liveAccountSnapshots, liveIntents, reconciliationIssues } from "@db/schema";
import type { LiveLedgerEntry } from "./accounting";
import type {
  BinanceAccountResponse,
  BinanceOpenOrder,
  BinancePositionRisk,
} from "./binanceSigned";
import { addDecimals, compareDecimals, decimal, subtractDecimals, type DecimalString } from "./decimal";
import type { LiveDatabase } from "./livePersistence";
import type {
  LiveOrder,
  LiveOrderStore,
  LivePosition,
  LivePositionSeed,
} from "./orderStateMachine";

export type ReconciliationIssueCategory =
  | "UNSETTLED_INTENT"
  | "UNPROTECTED_POSITION"
  | "BALANCE_MISMATCH"
  | "POSITION_MISMATCH"
  | "ORDER_MISMATCH"
  | "UNKNOWN_MANUAL_ORDER"
  | "UNKNOWN_MANUAL_POSITION"
  | "REST_RECONCILIATION"
  | "USER_DATA_EVENT";

export interface ReconciliationIssue {
  id: string;
  category: ReconciliationIssueCategory;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  symbol: string | null;
  expectedValue: DecimalString | null;
  actualValue: DecimalString | null;
  message: string;
  detectedAt: number;
  resolvedAt: number | null;
}

export type NewReconciliationIssue = Omit<ReconciliationIssue, "id" | "status" | "resolvedAt">;

export interface LiveAccountSnapshot {
  asset: string;
  walletBalance: DecimalString;
  availableBalance: DecimalString;
  crossWalletBalance: DecimalString;
  observedAt: number;
}

export interface UnsettledLiveIntent {
  id: string;
  symbol: string;
  status: string;
}

export interface ReconciliationIssueSummary {
  openIssues: number;
  severeIssues: number;
  lastDetectedAt: number | null;
}

export interface ReconciliationStore {
  recordIssue(issue: NewReconciliationIssue): Promise<ReconciliationIssue>;
  getIssueSummary(): Promise<ReconciliationIssueSummary>;
  listIssues(limit?: number): Promise<ReconciliationIssue[]>;
  listUnsettledIntents(limit?: number): Promise<UnsettledLiveIntent[]>;
  appendAccountSnapshot(snapshot: LiveAccountSnapshot): Promise<boolean>;
  latestAccountSnapshots(): Promise<LiveAccountSnapshot[]>;
  resolveBalanceIssues(asset: string, resolvedAt: number): Promise<void>;
}

export class InMemoryReconciliationStore implements ReconciliationStore {
  private readonly issues: ReconciliationIssue[] = [];
  private readonly snapshots = new Map<string, LiveAccountSnapshot>();
  private readonly unsettledIntents: UnsettledLiveIntent[];

  constructor(unsettledIntents: UnsettledLiveIntent[] = []) {
    this.unsettledIntents = unsettledIntents;
  }

  async listUnsettledIntents(limit?: number): Promise<UnsettledLiveIntent[]> {
    const rows = limit === undefined ? this.unsettledIntents : this.unsettledIntents.slice(0, limit);
    return rows.map((intent) => ({ ...intent }));
  }

  async recordIssue(issue: NewReconciliationIssue): Promise<ReconciliationIssue> {
    const recorded: ReconciliationIssue = {
      ...issue,
      id: crypto.randomUUID(),
      status: "OPEN",
      resolvedAt: null,
    };
    this.issues.push(recorded);
    return { ...recorded };
  }

  async listIssues(limit?: number): Promise<ReconciliationIssue[]> {
    const rows = limit === undefined ? this.issues : this.issues.slice(0, limit);
    return rows.map((issue) => ({ ...issue }));
  }

  async getIssueSummary(): Promise<ReconciliationIssueSummary> {
    const unresolved = this.issues.filter((issue) => issue.status !== "RESOLVED");
    return {
      openIssues: unresolved.length,
      severeIssues: unresolved.filter((issue) => issue.severity === "ERROR" || issue.severity === "CRITICAL").length,
      lastDetectedAt: unresolved.length > 0 ? Math.max(...unresolved.map((issue) => issue.detectedAt)) : null,
    };
  }

  async appendAccountSnapshot(snapshot: LiveAccountSnapshot): Promise<boolean> {
    const latest = this.snapshots.get(snapshot.asset);
    if (latest && snapshot.observedAt <= latest.observedAt) return false;
    this.snapshots.set(snapshot.asset, {
      ...snapshot,
      walletBalance: decimal(snapshot.walletBalance),
      availableBalance: decimal(snapshot.availableBalance),
      crossWalletBalance: decimal(snapshot.crossWalletBalance),
    });
    return true;
  }

  async latestAccountSnapshots(): Promise<LiveAccountSnapshot[]> {
    return [...this.snapshots.values()].sort((left, right) => left.asset.localeCompare(right.asset))
      .map((snapshot) => ({ ...snapshot }));
  }

  async resolveBalanceIssues(asset: string, resolvedAt: number): Promise<void> {
    for (const issue of this.issues) {
      if (issue.category === "BALANCE_MISMATCH" && issue.status !== "RESOLVED"
        && issue.message.startsWith(`${asset} `)) {
        issue.status = "RESOLVED";
        issue.resolvedAt = resolvedAt;
      }
    }
  }
}

export class DrizzleReconciliationStore implements ReconciliationStore {
  private readonly db: LiveDatabase;

  constructor(db: LiveDatabase) {
    this.db = db;
  }

  async listUnsettledIntents(limit?: number): Promise<UnsettledLiveIntent[]> {
    const query = this.db.select({ id: liveIntents.id, symbol: liveIntents.symbol, status: liveIntents.status })
      .from(liveIntents).where(notInArray(liveIntents.status, [
        "FILLED", "CANCEL", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED",
      ]));
    return limit === undefined ? query : query.limit(limit);
  }

  async recordIssue(issue: NewReconciliationIssue): Promise<ReconciliationIssue> {
    const id = crypto.randomUUID();
    await this.db.insert(reconciliationIssues).values({
      id,
      category: issue.category,
      severity: issue.severity,
      status: "OPEN",
      symbol: issue.symbol,
      expectedValue: issue.expectedValue,
      actualValue: issue.actualValue,
      message: issue.message,
      detectedAt: new Date(issue.detectedAt),
    });
    return { ...issue, id, status: "OPEN", resolvedAt: null };
  }

  async listIssues(limit?: number): Promise<ReconciliationIssue[]> {
    const query = this.db.select().from(reconciliationIssues)
      .orderBy(asc(reconciliationIssues.detectedAt), asc(reconciliationIssues.id));
    const rows = await (limit === undefined ? query : query.limit(limit));
    return rows.map((row) => ({
      id: row.id,
      category: row.category as ReconciliationIssueCategory,
      severity: row.severity as ReconciliationIssue["severity"],
      status: row.status as ReconciliationIssue["status"],
      symbol: row.symbol,
      expectedValue: row.expectedValue,
      actualValue: row.actualValue,
      message: row.message,
      detectedAt: row.detectedAt.getTime(),
      resolvedAt: row.resolvedAt?.getTime() ?? null,
    }));
  }

  async getIssueSummary(): Promise<ReconciliationIssueSummary> {
    const rows = await this.db.select({
      openIssues: sql<number>`COUNT(*)`,
      severeIssues: sql<number>`COALESCE(SUM(CASE WHEN severity IN ('ERROR', 'CRITICAL') THEN 1 ELSE 0 END), 0)`,
      lastDetectedAt: sql<string | number | null>`CAST(UNIX_TIMESTAMP(MAX(detected_at)) * 1000 AS UNSIGNED)`,
    }).from(reconciliationIssues).where(ne(reconciliationIssues.status, "RESOLVED"));
    const row = rows[0];
    return {
      openIssues: Number(row?.openIssues ?? 0),
      severeIssues: Number(row?.severeIssues ?? 0),
      lastDetectedAt: row?.lastDetectedAt === null || row?.lastDetectedAt === undefined
        ? null : Number(row.lastDetectedAt),
    };
  }

  async appendAccountSnapshot(snapshot: LiveAccountSnapshot): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const latest = await tx.select().from(liveAccountSnapshots)
        .where(eq(liveAccountSnapshots.asset, snapshot.asset))
        .orderBy(desc(liveAccountSnapshots.observedAt)).limit(1).for("update");
      if (latest[0] && snapshot.observedAt <= latest[0].observedAt.getTime()) return false;
      await tx.insert(liveAccountSnapshots).values({
        asset: snapshot.asset,
        walletBalance: decimal(snapshot.walletBalance),
        availableBalance: decimal(snapshot.availableBalance),
        crossWalletBalance: decimal(snapshot.crossWalletBalance),
        observedAt: new Date(snapshot.observedAt),
      });
      return true;
    });
  }

  async latestAccountSnapshots(): Promise<LiveAccountSnapshot[]> {
    const rows = await this.db.select().from(liveAccountSnapshots)
      .orderBy(asc(liveAccountSnapshots.asset), asc(liveAccountSnapshots.observedAt), asc(liveAccountSnapshots.id));
    const latest = new Map<string, LiveAccountSnapshot>();
    for (const row of rows) {
      latest.set(row.asset, {
        asset: row.asset,
        walletBalance: row.walletBalance,
        availableBalance: row.availableBalance,
        crossWalletBalance: row.crossWalletBalance,
        observedAt: row.observedAt.getTime(),
      });
    }
    return [...latest.values()];
  }

  async resolveBalanceIssues(asset: string, resolvedAt: number): Promise<void> {
    await this.db.update(reconciliationIssues).set({ status: "RESOLVED", resolvedAt: new Date(resolvedAt) })
      .where(and(
        eq(reconciliationIssues.category, "BALANCE_MISMATCH"),
        ne(reconciliationIssues.status, "RESOLVED"),
        like(reconciliationIssues.message, `${asset} %`),
      ));
  }
}

export interface ReconciliationClient {
  account(): Promise<BinanceAccountResponse>;
  positionRisk(symbol?: string): Promise<BinancePositionRisk[]>;
  openOrders(symbol?: string): Promise<BinanceOpenOrder[]>;
}

export interface OrderRecovery {
  recover(clientOrderId: string, recoverySeed?: LivePositionSeed): Promise<LiveOrder>;
}

export interface ReconciliationResult {
  ok: boolean;
  issues: ReconciliationIssue[];
}

export interface EntryResume {
  resume(): Promise<boolean>;
  discard(): Promise<void>;
}

export class LiveEntryAdmission {
  private generation = 0;
  private resumeOwner: symbol | null = null;
  private allowedState: boolean;
  private operatorPaused: boolean;
  private retryResume = false;

  constructor(initiallyAllowed = true) {
    this.allowedState = initiallyAllowed;
    this.operatorPaused = !initiallyAllowed;
  }

  get allowed(): boolean {
    return this.allowedState;
  }

  async suspend(): Promise<void> {
    if (this.operatorPaused) {
      this.allowedState = false;
      return;
    }
    if (this.allowedState || this.resumeOwner) this.retryResume = true;
    if (this.resumeOwner) {
      this.resumeOwner = null;
      this.generation += 1;
    }
    this.allowedState = false;
  }

  async pauseForReconciliation(): Promise<EntryResume | null> {
    if (this.resumeOwner || this.operatorPaused || (!this.allowedState && !this.retryResume)) return null;
    const owner = Symbol("reconciliation-resume");
    const generation = this.generation;
    this.resumeOwner = owner;
    this.retryResume = true;
    this.allowedState = false;
    return {
      resume: async () => {
        if (this.resumeOwner !== owner || this.generation !== generation) return false;
        this.resumeOwner = null;
        this.generation += 1;
        this.retryResume = false;
        this.allowedState = true;
        return true;
      },
      discard: async () => {
        if (this.resumeOwner !== owner || this.generation !== generation) return;
        this.resumeOwner = null;
        this.generation += 1;
        this.allowedState = false;
      },
    };
  }

  async pauseFromOperator(): Promise<void> {
    this.resumeOwner = null;
    this.generation += 1;
    this.retryResume = false;
    this.operatorPaused = true;
    this.allowedState = false;
  }
}

interface ReconciliationServiceOptions {
  client: ReconciliationClient;
  orders: LiveOrderStore;
  store: ReconciliationStore;
  recovery: OrderRecovery;
  accounting: { synchronize(): Promise<void> };
  seedFor?: (order: LiveOrder) => Promise<LivePositionSeed>;
  ledger?: { listLedgerEntries(): Promise<LiveLedgerEntry[]> };
  pauseNewEntries: () => Promise<EntryResume | null>;
  now?: () => number;
}

const TERMINAL_ORDER_STATUSES = new Set(["FILLED", "CANCEL"]);
const UNRESOLVED_RECOVERY_STATUSES = new Set(["UNKNOWN", "RECONCILING", "REPLACE"]);

function sameDecimal(left: DecimalString, right: DecimalString): boolean {
  return compareDecimals(left, right) === 0;
}

function localOrderIdentity(order: BinanceOpenOrder, localOrders: LiveOrder[]): boolean {
  return localOrders.some((local) => local.clientOrderId === order.clientOrderId
    || (local.exchangeOrderId !== null && local.exchangeOrderId === String(order.orderId)));
}

export class ReconciliationService {
  private readonly options: ReconciliationServiceOptions;
  private readonly now: () => number;

  constructor(options: ReconciliationServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async reconcile(): Promise<ReconciliationResult> {
    const mayResume = await this.options.pauseNewEntries();
    const issues: ReconciliationIssue[] = [];
    try {
      const initialOrders = await this.options.orders.listOrders();
      const positions = await this.options.orders.listOpenPositions();
      for (const order of initialOrders) {
        try {
          const existingPosition = positions.find((position) => position.id === order.intentId);
          const recoverySeed = existingPosition ?? await this.options.seedFor?.(order);
          const recovered = await this.options.recovery.recover(order.clientOrderId, recoverySeed);
          if (UNRESOLVED_RECOVERY_STATUSES.has(recovered.status)) throw new Error("Recovery remains unresolved");
        } catch {
          issues.push(await this.issue({
            category: "UNSETTLED_INTENT",
            severity: "CRITICAL",
            symbol: order.symbol,
            expectedValue: null,
            actualValue: null,
            message: `${order.clientOrderId} 重启恢复仍未结算，禁止新开仓`,
          }));
        }
      }

      await this.options.accounting.synchronize();
      const [account, remotePositions, remoteOrders, localOrders, localPositions, previousSnapshots, unsettledIntents] = await Promise.all([
        this.options.client.account(),
        this.options.client.positionRisk(),
        this.options.client.openOrders(),
        this.options.orders.listOrders(),
        this.options.orders.listOpenPositions(),
        this.options.store.latestAccountSnapshots(),
        this.options.store.listUnsettledIntents(),
      ]);

      for (const intent of unsettledIntents) {
        if (!localOrders.some((order) => order.intentId === intent.id)) {
          issues.push(await this.issue({
            category: "UNSETTLED_INTENT",
            severity: "CRITICAL",
            symbol: intent.symbol,
            expectedValue: null,
            actualValue: null,
            message: `${intent.id} 处于 ${intent.status} 但没有可恢复订单，禁止新开仓`,
          }));
        }
      }
      for (const remote of remoteOrders) {
        if (!localOrderIdentity(remote, localOrders)) {
          issues.push(await this.issue({
            category: "UNKNOWN_MANUAL_ORDER",
            severity: "CRITICAL",
            symbol: remote.symbol,
            expectedValue: null,
            actualValue: null,
            message: `发现未知人工或外部订单 ${remote.clientOrderId}，仅冻结并报告`,
          }));
        }
      }
      for (const local of localOrders) {
        if (TERMINAL_ORDER_STATUSES.has(local.status)) continue;
        const remote = remoteOrders.find((candidate) => candidate.clientOrderId === local.clientOrderId
          || (local.exchangeOrderId !== null && String(candidate.orderId) === local.exchangeOrderId));
        if (!remote) {
          issues.push(await this.issue({
            category: local.status === "UNKNOWN" ? "UNSETTLED_INTENT" : "ORDER_MISMATCH",
            severity: "CRITICAL",
            symbol: local.symbol,
            expectedValue: local.originalQuantity,
            actualValue: null,
            message: `${local.clientOrderId} 在交易所工作单中无法确认`,
          }));
          continue;
        }
        if (remote.clientOrderId !== local.clientOrderId
          || (local.exchangeOrderId !== null && String(remote.orderId) !== local.exchangeOrderId)
          || !sameDecimal(local.originalQuantity, remote.origQty)
          || !sameDecimal(local.executedQuantity, remote.executedQty)) {
          issues.push(await this.issue({
            category: "ORDER_MISMATCH",
            severity: "CRITICAL",
            symbol: local.symbol,
            expectedValue: decimal(local.executedQuantity),
            actualValue: decimal(remote.executedQty),
            message: `${local.clientOrderId} 的 exchange/client ID、原始数量或实际累计成交不一致`,
          }));
        }
      }

      const activeRemotePositions = remotePositions.filter((position) => !sameDecimal(position.positionAmt, "0"));
      for (const remote of activeRemotePositions) {
        const local = localPositions.find((position) => position.symbol === remote.symbol);
        if (!local) {
          issues.push(await this.issue({
            category: "UNKNOWN_MANUAL_POSITION",
            severity: "CRITICAL",
            symbol: remote.symbol,
            expectedValue: "0",
            actualValue: decimal(remote.positionAmt),
            message: `${remote.symbol} 存在未知人工或外部持仓，仅冻结并报告`,
          }));
          continue;
        }
        const expectedQuantity = signedPositionQuantity(local);
        if (!sameDecimal(expectedQuantity, remote.positionAmt)) {
          issues.push(await this.issue({
            category: "POSITION_MISMATCH",
            severity: "CRITICAL",
            symbol: remote.symbol,
            expectedValue: expectedQuantity,
            actualValue: decimal(remote.positionAmt),
            message: `${remote.symbol} 交易所与数据库持仓数量或方向不一致`,
          }));
        }
      }
      for (const local of localPositions) {
        const remote = activeRemotePositions.find((position) => position.symbol === local.symbol);
        if (!remote) {
          issues.push(await this.issue({
            category: "POSITION_MISMATCH",
            severity: "CRITICAL",
            symbol: local.symbol,
            expectedValue: decimal(local.quantity),
            actualValue: "0",
            message: `${local.symbol} 数据库持仓在交易所不存在`,
          }));
        }
        if (!this.hasProtection(local, remoteOrders)) {
          issues.push(await this.issue({
            category: "UNPROTECTED_POSITION",
            severity: "CRITICAL",
            symbol: local.symbol,
            expectedValue: decimal(local.quantity),
            actualValue: "0",
            message: `${local.symbol} 缺少数量与止损价格一致的交易所原生 reduceOnly STOP_MARKET`,
          }));
        }
      }

      const previousByAsset = new Map(previousSnapshots.map((snapshot) => [snapshot.asset, snapshot]));
      const ledgerEntries = await this.options.ledger?.listLedgerEntries() ?? [];
      for (const asset of account.assets) {
        const previous = previousByAsset.get(asset.asset);
        const crossWalletBalance = asset.crossWalletBalance ?? asset.walletBalance;
        const observedAt = this.now();
        if (previous) {
          const expectedWallet = ledgerEntries
            .filter((entry) => entry.asset === asset.asset
              && entry.occurredAt > previous.observedAt && entry.occurredAt <= observedAt)
            .reduce((total, entry) => {
              const signedAmount = entry.entryType === "COMMISSION" && compareDecimals(entry.amount, "0") > 0
                ? `-${decimal(entry.amount)}` : entry.amount;
              return addDecimals(total, signedAmount);
            }, previous.walletBalance as DecimalString);
          const walletExplained = sameDecimal(expectedWallet, asset.walletBalance);
          const ledgerDelta = subtractDecimals(expectedWallet, previous.walletBalance);
          const expectedCrossWallet = addDecimals(previous.crossWalletBalance, ledgerDelta);
          if (walletExplained && sameDecimal(expectedCrossWallet, crossWalletBalance)) {
            await this.options.store.resolveBalanceIssues(asset.asset, observedAt);
          }
          const difference = !walletExplained
            ? ([expectedWallet, asset.walletBalance, "wallet"] as const)
            : !sameDecimal(expectedCrossWallet, crossWalletBalance)
              ? ([expectedCrossWallet, crossWalletBalance, "cross wallet"] as const)
              : null;
          if (difference) {
            issues.push(await this.issue({
              category: "BALANCE_MISMATCH",
              severity: "ERROR",
              symbol: null,
              expectedValue: decimal(difference[0]),
              actualValue: decimal(difference[1]),
              message: `${asset.asset} ${difference[2]} balance 与上次持久化快照及账本预期不一致`,
            }));
          }
        }
        await this.options.store.appendAccountSnapshot({
          asset: asset.asset,
          walletBalance: decimal(asset.walletBalance),
          availableBalance: decimal(asset.availableBalance),
          crossWalletBalance: decimal(crossWalletBalance),
          observedAt,
        });
      }
    } catch {
      issues.push(await this.issue({
        category: "REST_RECONCILIATION",
        severity: "CRITICAL",
        symbol: null,
        expectedValue: null,
        actualValue: null,
        message: "REST 对账失败，保持新开仓冻结",
      }));
    }

    const ok = issues.length === 0;
    if (ok) await mayResume?.resume();
    else await mayResume?.discard();
    return { ok, issues };
  }

  private hasProtection(position: LivePosition, orders: BinanceOpenOrder[]): boolean {
    const side = position.side === "LONG" ? "SELL" : "BUY";
    return orders.some((order) => order.symbol === position.symbol && order.reduceOnly === true
      && order.type === "STOP_MARKET" && order.side === side
      && sameDecimal(order.origQty, position.quantity)
      && typeof order.stopPrice === "string" && sameDecimal(order.stopPrice, position.stopPrice));
  }

  private issue(issue: Omit<NewReconciliationIssue, "detectedAt">): Promise<ReconciliationIssue> {
    return this.options.store.recordIssue({ ...issue, detectedAt: this.now() });
  }
}

export function signedPositionQuantity(position: LivePosition): DecimalString {
  return position.side === "SHORT" ? `-${decimal(position.quantity)}` : decimal(position.quantity);
}
