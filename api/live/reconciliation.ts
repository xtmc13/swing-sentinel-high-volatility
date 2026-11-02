import { asc, desc, eq, notInArray } from "drizzle-orm";
import { liveAccountSnapshots, liveIntents, reconciliationIssues } from "@db/schema";
import type {
  BinanceAccountResponse,
  BinanceOpenOrder,
  BinancePositionRisk,
} from "./binanceSigned";
import { compareDecimals, decimal, type DecimalString } from "./decimal";
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

export interface ReconciliationStore {
  recordIssue(issue: NewReconciliationIssue): Promise<ReconciliationIssue>;
  listIssues(): Promise<ReconciliationIssue[]>;
  listUnsettledIntents(): Promise<UnsettledLiveIntent[]>;
  appendAccountSnapshot(snapshot: LiveAccountSnapshot): Promise<boolean>;
  latestAccountSnapshots(): Promise<LiveAccountSnapshot[]>;
}

export class InMemoryReconciliationStore implements ReconciliationStore {
  private readonly issues: ReconciliationIssue[] = [];
  private readonly snapshots = new Map<string, LiveAccountSnapshot>();

  constructor(private readonly unsettledIntents: UnsettledLiveIntent[] = []) {}

  async listUnsettledIntents(): Promise<UnsettledLiveIntent[]> {
    return this.unsettledIntents.map((intent) => ({ ...intent }));
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

  async listIssues(): Promise<ReconciliationIssue[]> {
    return this.issues.map((issue) => ({ ...issue }));
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
}

export class DrizzleReconciliationStore implements ReconciliationStore {
  constructor(private readonly db: LiveDatabase) {}

  async listUnsettledIntents(): Promise<UnsettledLiveIntent[]> {
    return this.db.select({ id: liveIntents.id, symbol: liveIntents.symbol, status: liveIntents.status })
      .from(liveIntents).where(notInArray(liveIntents.status, [
        "FILLED", "CANCEL", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED",
      ]));
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

  async listIssues(): Promise<ReconciliationIssue[]> {
    const rows = await this.db.select().from(reconciliationIssues)
      .orderBy(asc(reconciliationIssues.detectedAt), asc(reconciliationIssues.id));
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
}

export class LiveEntryAdmission {
  private generation = 0;
  private resumeOwner: symbol | null = null;

  constructor(private initiallyAllowed = true) {}

  get allowed(): boolean {
    return this.initiallyAllowed;
  }

  async pauseForReconciliation(): Promise<EntryResume | null> {
    if (!this.initiallyAllowed || this.resumeOwner) return null;
    const owner = Symbol("reconciliation-resume");
    const generation = this.generation;
    this.resumeOwner = owner;
    this.initiallyAllowed = false;
    return {
      resume: async () => {
        if (this.resumeOwner !== owner || this.generation !== generation) return false;
        this.resumeOwner = null;
        this.generation += 1;
        this.initiallyAllowed = true;
        return true;
      },
    };
  }

  async pauseFromOperator(): Promise<void> {
    this.resumeOwner = null;
    this.generation += 1;
    this.initiallyAllowed = false;
  }
}

interface ReconciliationServiceOptions {
  client: ReconciliationClient;
  orders: LiveOrderStore;
  store: ReconciliationStore;
  recovery: OrderRecovery;
  accounting: { synchronize(): Promise<void> };
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
  private readonly now: () => number;

  constructor(private readonly options: ReconciliationServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async reconcile(): Promise<ReconciliationResult> {
    const mayResume = await this.options.pauseNewEntries();
    const issues: ReconciliationIssue[] = [];
    try {
      const initialOrders = await this.options.orders.listOrders();
      const positions = await this.options.orders.listOpenPositions();
      for (const order of initialOrders) {
        if (TERMINAL_ORDER_STATUSES.has(order.status)) continue;
        try {
          const recovered = await this.options.recovery.recover(order.clientOrderId,
            positions.find((position) => position.id === order.intentId));
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
            message: `${local.symbol} 缺少覆盖实际持仓的交易所原生 reduceOnly STOP_MARKET`,
          }));
        }
      }

      const previousByAsset = new Map(previousSnapshots.map((snapshot) => [snapshot.asset, snapshot]));
      for (const asset of account.assets) {
        const previous = previousByAsset.get(asset.asset);
        const crossWalletBalance = asset.crossWalletBalance ?? asset.walletBalance;
        if (previous) {
          const difference = !sameDecimal(previous.walletBalance, asset.walletBalance)
            ? ([previous.walletBalance, asset.walletBalance, "wallet"] as const)
            : !sameDecimal(previous.availableBalance, asset.availableBalance)
              ? ([previous.availableBalance, asset.availableBalance, "available"] as const)
              : !sameDecimal(previous.crossWalletBalance, crossWalletBalance)
                ? ([previous.crossWalletBalance, crossWalletBalance, "cross wallet"] as const)
                : null;
          if (difference) {
            issues.push(await this.issue({
              category: "BALANCE_MISMATCH",
              severity: "ERROR",
              symbol: null,
              expectedValue: decimal(difference[0]),
              actualValue: decimal(difference[1]),
              message: `${asset.asset} ${difference[2]} balance 与上次持久化快照不一致`,
            }));
          }
        }
        await this.options.store.appendAccountSnapshot({
          asset: asset.asset,
          walletBalance: decimal(asset.walletBalance),
          availableBalance: decimal(asset.availableBalance),
          crossWalletBalance: decimal(crossWalletBalance),
          observedAt: this.now(),
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
    return { ok, issues };
  }

  private hasProtection(position: LivePosition, orders: BinanceOpenOrder[]): boolean {
    const side = position.side === "LONG" ? "SELL" : "BUY";
    return orders.some((order) => order.symbol === position.symbol && order.reduceOnly === true
      && order.type === "STOP_MARKET" && order.side === side
      && sameDecimal(order.origQty, position.quantity));
  }

  private issue(issue: Omit<NewReconciliationIssue, "detectedAt">): Promise<ReconciliationIssue> {
    return this.options.store.recordIssue({ ...issue, detectedAt: this.now() });
  }
}

export function signedPositionQuantity(position: LivePosition): DecimalString {
  return position.side === "SHORT" ? `-${decimal(position.quantity)}` : decimal(position.quantity);
}
