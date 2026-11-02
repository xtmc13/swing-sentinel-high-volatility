import { eq } from "drizzle-orm";
import { binance } from "./binance";
import {
  DEFAULT_LIVE_CONTROLS,
  type AccountSnapshot,
  type DataSource,
  type ExecutionMode,
  type ExecutionStatus,
  type LiveControls,
  type LiveReadiness,
  type Opportunity,
  type PositionView,
  type PrivateWsHealth,
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
import {
  evaluateMomentumExit,
  momentumFeatureFrameSchema,
  type MomentumFeatureFrame,
} from "./momentum";
import {
  drizzleMomentumStateStore,
  type MomentumStateStore,
} from "./momentumState";
import { DrizzleLiveOrderStore } from "../live/drizzleLiveOrderStore";
import { DrizzleReconciliationStore } from "../live/reconciliation";
import { readLiveOperations, type LiveOperations } from "../live/liveOperations";

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
  open(
    opportunity: Opportunity,
    executionHealthy?: () => boolean,
    options?: { manualCanary?: boolean },
  ): Promise<OpenExecutionResult>;
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

export interface ExecutionDashboard extends ExecutionSnapshot, LiveOperations {
  status: ExecutionStatus;
}

export interface ExecutionCoordinatorDependencies {
  paper?: ExecutionAdapter;
  live?: ExecutionAdapter;
  getSettings?: () => Promise<TradingSettings>;
  saveSettings?: (settings: TradingSettings) => Promise<void>;
  getLiveControls?: () => Promise<LiveControls>;
  setLiveControls?: (controls: LiveControls) => Promise<void>;
  getOutstandingRisk?: () => Promise<OutstandingExecutionRisk>;
  getLiveOperations?: () => Promise<LiveOperations>;
  runLivePreflight?: () => Promise<LiveReadiness>;
  privateWs?: { health(): PrivateWsHealth };
  market?: { readonly dataSource: DataSource };
  env?: Record<string, string | undefined>;
  now?: () => number;
  momentumStore?: MomentumStateStore;
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

async function defaultSetLiveControls(controls: LiveControls): Promise<void> {
  await getDb().insert(liveControls).values({ id: 1, ...controls })
    .onDuplicateKeyUpdate({ set: { armed: controls.armed } });
}

async function defaultLiveOperations(): Promise<LiveOperations> {
  const db = getDb();
  return readLiveOperations(new DrizzleLiveOrderStore(db), new DrizzleReconciliationStore(db));
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
  private lastPreflight: LiveReadiness = { ready: false, reasons: ["尚未执行主网预检"], checkedAt: null };
  private lastMomentumFrame: MomentumFeatureFrame | null = null;

  constructor(dependencies: ExecutionCoordinatorDependencies = {}) {
    this.dependencies = dependencies;
  }

  private get paper() {
    return this.dependencies.paper ?? paperExecutionAdapter;
  }

  private get momentumStore() {
    return this.dependencies.momentumStore ?? drizzleMomentumStateStore;
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

  async observeMomentumFrame(frame: MomentumFeatureFrame) {
    const parsed = momentumFeatureFrameSchema.safeParse(frame);
    if (!parsed.success) throw new Error("动量特征格式无效");
    await this.momentumStore.saveFrame(parsed.data);
    this.lastMomentumFrame = parsed.data;
  }

  async receiveMomentumFrame(frame: MomentumFeatureFrame) {
    await this.observeMomentumFrame(frame);
    await this.manageMomentumExits();
  }

  async open(opportunity: Opportunity, executionHealthy?: () => boolean): Promise<OpenExecutionResult> {
    return this.serializeOpenSwitch(() => this.openWhenSerialized(opportunity, executionHealthy, false));
  }

  async openManual(opportunity: Opportunity, executionHealthy?: () => boolean): Promise<OpenExecutionResult> {
    return this.serializeOpenSwitch(() => this.openWhenSerialized(opportunity, executionHealthy, true));
  }

  private async runPreflight(): Promise<LiveReadiness> {
    this.lastPreflight = this.dependencies.runLivePreflight
      ? await this.dependencies.runLivePreflight()
      : { ready: false, reasons: ["主网预检未配置"], checkedAt: null };
    return this.lastPreflight;
  }

  private async openWhenSerialized(
    opportunity: Opportunity,
    executionHealthy: (() => boolean) | undefined,
    manualCanary: boolean,
  ): Promise<OpenExecutionResult> {
    const settings = await this.settings();
    const guardedMomentumSignal = opportunity.strategyType === "MOMENTUM";
    if (guardedMomentumSignal && (!settings.momentumEnabled || settings.strategyMode === "SWING")) {
      return { ok: false, reason: "动量模式已关闭" };
    }
    if (settings.executionMode === "LIVE_MAINNET") {
      if (this.marketSource === "TESTNET") return { ok: false, reason: "TESTNET 行情禁止选择 LIVE_MAINNET" };
      if (!liveTradingEnabled(this.dependencies.env ?? process.env)) {
        return { ok: false, reason: "LIVE_TRADING_ENABLED 未开启" };
      }
      const controls = await (this.dependencies.getLiveControls ?? defaultLiveControls)();
      if (!controls.armed) return { ok: false, reason: "主网执行未 armed" };
      if (!manualCanary && !settings.autoTrade) return { ok: false, reason: "自动交易已暂停" };
      if (!this.dependencies.live) return { ok: false, reason: "LIVE_MAINNET adapter 尚未配置" };
      const preflight = await this.runPreflight();
      if (!preflight.ready) return { ok: false, reason: `主网预检未通过：${preflight.reasons.join("；") || "未知原因"}` };
    }

    if (guardedMomentumSignal && opportunity.expiryTime <= this.now()) {
      return { ok: false, reason: "动量信号已过期" };
    }
    if (guardedMomentumSignal && this.consumedMomentumSignals.has(opportunity.signalId)) {
      return { ok: false, reason: "动量信号已执行" };
    }
    if (guardedMomentumSignal) this.consumedMomentumSignals.add(opportunity.signalId);
    try {
      const selectedAdapter = this.adapter(settings);
      const result = manualCanary
        ? await selectedAdapter.open(opportunity, executionHealthy, { manualCanary: true })
        : await selectedAdapter.open(opportunity, executionHealthy);
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
    const adapter = this.adapter(await this.settings());
    await adapter.manage();
    await this.manageMomentumExits();
  }

  async manageMomentumExits(): Promise<void> {
    const settings = await this.settings();
    const adapter = this.adapter(settings);
    const openPositions = await adapter.positions();
    for (const position of openPositions) {
      if (position.strategyType !== "MOMENTUM" || position.breakoutPrice === undefined
        || !position.valuationValid) continue;
      const frame = await this.momentumStore.latestFrame(position.symbol);
      const now = this.now();
      const freshFramePrice = frame?.quality === "GOOD" && frame.received_time >= frame.event_time
        && now >= frame.event_time && now - frame.event_time <= 750 && now - frame.received_time <= 750
        ? frame.mark_price : null;
      const reason = evaluateMomentumExit({
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        price: freshFramePrice ?? position.markPrice,
        breakoutPrice: position.breakoutPrice,
        openedAt: Date.parse(position.openedAt),
        now,
        frame,
      });
      if (!reason) continue;
      const claimId = crypto.randomUUID();
      const claimed = await this.momentumStore.claimExit(
        settings.executionMode,
        position.id,
        reason,
        claimId,
        now,
        5_000,
      );
      if (!claimed) continue;
      const result = await adapter.close(position.id, reason);
      if (result.ok || result.unsettled) {
        await this.momentumStore.markExitSubmitted(settings.executionMode, position.id, claimId);
      } else {
        await this.momentumStore.releaseExit(settings.executionMode, position.id, claimId);
      }
    }
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

  private buildStatus(
    settings: TradingSettings,
    controls: LiveControls,
    outstanding: OutstandingExecutionRisk,
    operations: LiveOperations,
    positions: PositionView[],
  ): ExecutionStatus {
    const env = this.dependencies.env ?? process.env;
    const environmentEnabled = liveTradingEnabled(env);
    const adapterConfigured = this.dependencies.live !== undefined;
    const reasons: string[] = [];
    if (settings.executionMode === "LIVE_MAINNET") {
      if (this.marketSource === "TESTNET") reasons.push("TESTNET 行情禁止真实执行");
      if (!environmentEnabled) reasons.push("LIVE_TRADING_ENABLED 未开启");
      if (!controls.armed) reasons.push("主网执行未 armed");
      if (!adapterConfigured) reasons.push("LIVE_MAINNET adapter 尚未配置");
      if (!this.lastPreflight.ready) reasons.push(...this.lastPreflight.reasons);
      if (!settings.autoTrade) reasons.push("自动交易已暂停（手动 canary 不受影响）");
    }
    const frame = this.lastMomentumFrame;
    const frameFresh = frame !== null && frame.quality === "GOOD"
      && this.now() >= frame.received_time && this.now() - frame.received_time <= 5_000;
    const momentum = {
      enabled: settings.momentumEnabled,
      healthy: settings.momentumEnabled && frameFresh,
      lastFrameAt: frame ? new Date(frame.received_time).toISOString() : null,
      reason: !settings.momentumEnabled ? "动量检测已关闭"
        : !frame ? "尚未收到动量特征帧"
          : frameFresh ? "动量特征帧新鲜" : "动量特征帧陈旧或质量不合格",
    };
    const openIssues = operations.reconciliationIssues.filter((issue) => issue.status !== "RESOLVED");
    const severeIssues = openIssues.filter((issue) => issue.severity === "ERROR" || issue.severity === "CRITICAL");
    const latestIssue = operations.reconciliationIssues.reduce<number>(
      (latest, issue) => Math.max(latest, Date.parse(issue.detectedAt)),
      0,
    );
    const terminal = new Set(["FILLED", "CANCEL", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"]);
    const missingProtections = settings.executionMode === "LIVE_MAINNET"
      ? positions.filter((position) => !operations.orders.some((order) => order.intentId === position.id
        && order.type === "STOP_MARKET" && !terminal.has(order.status)))
        .map((position) => `${position.symbol} 缺少有效止损保护`)
      : [];
    return {
      executionMode: settings.executionMode,
      armed: controls.armed,
      environmentEnabled,
      credentialsConfigured: Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET),
      adapterConfigured,
      canSubmit: settings.executionMode === "LIVE_MAINNET" && reasons.length === 0,
      reasons,
      preflight: this.lastPreflight,
      momentum,
      outstanding,
      reconciliation: {
        configured: true,
        healthy: severeIssues.length === 0,
        openIssues: openIssues.length,
        severeIssues: severeIssues.length,
        lastDetectedAt: latestIssue > 0 ? new Date(latestIssue).toISOString() : null,
      },
      privateWs: this.dependencies.privateWs?.health() ?? {
        configured: false,
        running: false,
        connected: false,
        lastMessageAt: null,
        reconnects: 0,
      },
      missingProtections,
    };
  }

  async status(): Promise<ExecutionStatus> {
    const settings = await this.settings();
    const selectedAdapter = settings.executionMode === "PAPER" || this.dependencies.live
      ? this.adapter(settings) : null;
    const positionPromise = selectedAdapter?.positions() ?? Promise.resolve([]);
    const [controls, operations, outstanding, positions] = await Promise.all([
      (this.dependencies.getLiveControls ?? defaultLiveControls)(),
      (this.dependencies.getLiveOperations ?? defaultLiveOperations)(),
      this.dependencies.getOutstandingRisk?.() ?? defaultOutstandingRisk(positionPromise),
      positionPromise,
    ]);
    return this.buildStatus(settings, controls, outstanding, operations, positions);
  }

  async dashboard(): Promise<ExecutionDashboard> {
    const settings = await this.settings();
    const unavailableSnapshot: ExecutionSnapshot = {
      account: {
        equity: Number.NaN,
        cash: Number.NaN,
        availableMargin: Number.NaN,
        usedMargin: Number.NaN,
        unrealizedPnl: Number.NaN,
        realizedPnl: Number.NaN,
        todayPnl: Number.NaN,
        todayPnlPct: Number.NaN,
        dayStartEquity: Number.NaN,
        valuationValid: false,
        valuationIssues: ["LIVE_MAINNET adapter 尚未配置"],
        dailyLocked: true,
      },
      positions: [],
    };
    const snapshotPromise = settings.executionMode === "LIVE_MAINNET" && !this.dependencies.live
      ? Promise.resolve(unavailableSnapshot) : this.adapter(settings).snapshot();
    const [snapshot, controls, operations] = await Promise.all([
      snapshotPromise,
      (this.dependencies.getLiveControls ?? defaultLiveControls)(),
      (this.dependencies.getLiveOperations ?? defaultLiveOperations)(),
    ]);
    const outstanding = this.dependencies.getOutstandingRisk
      ? await this.dependencies.getOutstandingRisk()
      : await defaultOutstandingRisk(Promise.resolve(snapshot.positions));
    return {
      ...snapshot,
      ...operations,
      status: this.buildStatus(settings, controls, outstanding, operations, snapshot.positions),
    };
  }

  async setArmed(armed: boolean): Promise<ExecutionStatus> {
    return this.serializeOpenSwitch(async () => {
      if (armed) {
        const settings = await this.settings();
        if (settings.executionMode !== "LIVE_MAINNET") throw new Error("只有 LIVE_MAINNET 模式可以 armed");
        if (this.marketSource === "TESTNET") throw new Error("TESTNET 行情禁止 armed");
        if (!liveTradingEnabled(this.dependencies.env ?? process.env)) throw new Error("LIVE_TRADING_ENABLED 未开启");
        if (!this.dependencies.live) throw new Error("LIVE_MAINNET adapter 尚未配置");
        const preflight = await this.runPreflight();
        if (!preflight.ready) throw new Error(`主网预检未通过：${preflight.reasons.join("；") || "未知原因"}`);
      }
      await (this.dependencies.setLiveControls ?? defaultSetLiveControls)({ armed });
      return this.status();
    });
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
