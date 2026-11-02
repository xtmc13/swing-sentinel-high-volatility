import { eq } from "drizzle-orm";
import { binance } from "./binance";
import {
  DEFAULT_LIVE_CONTROLS,
  type AccountSnapshot,
  type DataSource,
  type ExecutionMode,
  type LiveControls,
  type Opportunity,
  type PositionView,
  type TradingSettings,
} from "@contracts/trading";
import { liveControls } from "@db/schema";
import { getDb } from "../queries/connection";
import { getOutstandingOrderCounts, getSettings, switchExecutionModeAtomic } from "../queries/trading";
import {
  closePaperPosition,
  emergencyStop,
  getAccountSnapshot,
  getAccountSnapshotWithPositions,
  manageOpenPositions,
  openPaperPosition,
} from "./paper";

export type OpenExecutionResult =
  | { ok: true; positionId: string; reason: string }
  | { ok: false; reason: string };
export type CloseExecutionResult = Awaited<ReturnType<typeof closePaperPosition>>
  | { ok: true; reason: string; pnl: number; unsettled: true; alreadyClosed: false };
export type EmergencyExecutionResult = Awaited<ReturnType<typeof emergencyStop>>;

export interface ExecutionSnapshot {
  account: AccountSnapshot;
  positions: PositionView[];
}

export interface ExecutionAdapter {
  open(opportunity: Opportunity, executionHealthy?: () => boolean): Promise<OpenExecutionResult>;
  close(positionId: string, reason?: string): Promise<CloseExecutionResult>;
  manage(): Promise<void>;
  emergency(): Promise<EmergencyExecutionResult>;
  account(): Promise<AccountSnapshot>;
  positions(): Promise<PositionView[]>;
  snapshot(): Promise<ExecutionSnapshot>;
}

export interface OutstandingExecutionRisk {
  openPositions: number;
  pendingIntents: number;
  unfinishedOrders: number;
}

export interface ExecutionCoordinatorDependencies {
  paper?: ExecutionAdapter;
  live?: ExecutionAdapter;
  getSettings?: () => Promise<TradingSettings>;
  saveSettings?: (settings: TradingSettings) => Promise<void>;
  getLiveControls?: () => Promise<LiveControls>;
  getOutstandingRisk?: () => Promise<OutstandingExecutionRisk>;
  market?: { readonly dataSource: DataSource };
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export const paperExecutionAdapter: ExecutionAdapter = {
  open: openPaperPosition,
  close: closePaperPosition,
  manage: manageOpenPositions,
  emergency: emergencyStop,
  account: getAccountSnapshot,
  positions: async () => (await getAccountSnapshotWithPositions()).positions,
  snapshot: getAccountSnapshotWithPositions,
};

export function liveTradingEnabled(env: Record<string, string | undefined>): boolean {
  return env.LIVE_TRADING_ENABLED === "true";
}

async function defaultLiveControls(): Promise<LiveControls> {
  const db = getDb();
  const rows = await db.select().from(liveControls).where(eq(liveControls.id, 1)).limit(1);
  if (rows[0]) return { armed: rows[0].armed };
  await db.insert(liveControls).values({ id: 1, ...DEFAULT_LIVE_CONTROLS })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  return { ...DEFAULT_LIVE_CONTROLS };
}

async function defaultOutstandingRisk(positionViews: Promise<PositionView[]>): Promise<OutstandingExecutionRisk> {
  const [openPositions, counts] = await Promise.all([
    positionViews,
    getOutstandingOrderCounts(),
  ]);
  return {
    openPositions: openPositions.length,
    ...counts,
  };
}

export class ExecutionCoordinator {
  private readonly consumedMomentumSignals = new Set<string>();
  private readonly dependencies: ExecutionCoordinatorDependencies;
  private openSwitchTail: Promise<void> = Promise.resolve();

  constructor(dependencies: ExecutionCoordinatorDependencies = {}) {
    this.dependencies = dependencies;
  }

  private get paper() {
    return this.dependencies.paper ?? paperExecutionAdapter;
  }

  private get marketSource(): DataSource {
    return this.dependencies.market?.dataSource ?? "MAINNET";
  }

  private now() {
    return (this.dependencies.now ?? Date.now)();
  }

  private settings() {
    return (this.dependencies.getSettings ?? getSettings)();
  }

  private adapter(settings: TradingSettings): ExecutionAdapter {
    if (settings.executionMode === "PAPER") return this.paper;
    if (this.marketSource === "TESTNET") throw new Error("TESTNET 行情禁止选择 LIVE_MAINNET");
    if (!this.dependencies.live) throw new Error("LIVE_MAINNET adapter 尚未配置");
    return this.dependencies.live;
  }

  private async serializeOpenSwitch<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.openSwitchTail;
    let release!: () => void;
    this.openSwitchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async open(opportunity: Opportunity, executionHealthy?: () => boolean): Promise<OpenExecutionResult> {
    return this.serializeOpenSwitch(() => this.openWhenSerialized(opportunity, executionHealthy));
  }

  private async openWhenSerialized(opportunity: Opportunity, executionHealthy?: () => boolean): Promise<OpenExecutionResult> {
    const settings = await this.settings();
    if (settings.executionMode === "LIVE_MAINNET") {
      if (this.marketSource === "TESTNET") return { ok: false, reason: "TESTNET 行情禁止选择 LIVE_MAINNET" };
      if (!liveTradingEnabled(this.dependencies.env ?? process.env)) {
        return { ok: false, reason: "LIVE_TRADING_ENABLED 未开启" };
      }
      const controls = await (this.dependencies.getLiveControls ?? defaultLiveControls)();
      if (!controls.armed) return { ok: false, reason: "主网执行未 armed" };
      if (!settings.autoTrade) return { ok: false, reason: "自动交易已暂停" };
      if (!this.dependencies.live) return { ok: false, reason: "LIVE_MAINNET adapter 尚未配置" };
    }

    const guardedMomentumSignal = opportunity.strategyType === "MOMENTUM";
    if (guardedMomentumSignal && opportunity.expiryTime <= this.now()) {
      return { ok: false, reason: "动量信号已过期" };
    }
    if (guardedMomentumSignal && this.consumedMomentumSignals.has(opportunity.signalId)) {
      return { ok: false, reason: "动量信号已执行" };
    }
    if (guardedMomentumSignal) this.consumedMomentumSignals.add(opportunity.signalId);
    try {
      const result = await this.adapter(settings).open(opportunity, executionHealthy);
      if (!result.ok && guardedMomentumSignal) this.consumedMomentumSignals.delete(opportunity.signalId);
      return result;
    } catch (error) {
      if (guardedMomentumSignal) this.consumedMomentumSignals.delete(opportunity.signalId);
      throw error;
    }
  }

  async close(positionId: string, reason?: string): Promise<CloseExecutionResult> {
    return this.adapter(await this.settings()).close(positionId, reason);
  }

  async manage(): Promise<void> {
    return this.adapter(await this.settings()).manage();
  }

  async emergency(): Promise<EmergencyExecutionResult> {
    return this.adapter(await this.settings()).emergency();
  }

  async account(): Promise<AccountSnapshot> {
    return this.adapter(await this.settings()).account();
  }

  async positions(): Promise<PositionView[]> {
    return this.adapter(await this.settings()).positions();
  }

  async snapshot(): Promise<ExecutionSnapshot> {
    return this.adapter(await this.settings()).snapshot();
  }

  async switchExecutionMode(executionMode: ExecutionMode): Promise<TradingSettings> {
    return this.serializeOpenSwitch(() => this.switchExecutionModeWhenSerialized(executionMode));
  }

  private async switchExecutionModeWhenSerialized(executionMode: ExecutionMode): Promise<TradingSettings> {
    const settings = await this.settings();
    if (settings.executionMode === executionMode) return settings;
    if (executionMode === "LIVE_MAINNET" && this.marketSource === "TESTNET") {
      throw new Error("TESTNET 行情禁止选择 LIVE_MAINNET");
    }
    const risk = this.dependencies.getOutstandingRisk
      ? await this.dependencies.getOutstandingRisk()
      : await defaultOutstandingRisk(this.adapter(settings).positions());
    if (risk.openPositions > 0 || risk.pendingIntents > 0 || risk.unfinishedOrders > 0) {
      throw new Error("存在未结持仓、意图或未完成订单，禁止切换执行模式");
    }
    const next = { ...settings, executionMode };
    if (this.dependencies.saveSettings) await this.dependencies.saveSettings(next);
    else await switchExecutionModeAtomic(executionMode);
    return next;
  }
}

export function createExecutionCoordinator(dependencies: ExecutionCoordinatorDependencies = {}) {
  return new ExecutionCoordinator(dependencies);
}

export const executionCoordinator = createExecutionCoordinator({ market: binance });
