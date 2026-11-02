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
import { liveControls, livePositions, positions } from "@db/schema";
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
import {
  createLiveAdmissionGuard,
  getLivePublicStatus,
  liveTradingEnabled,
  type AssertCurrentLiveAdmission,
} from "../live/liveConfig";
import { setLiveArmed } from "../live/livePersistence";
import { productionLiveRuntime } from "../live/productionSingleton";

export { liveTradingEnabled } from "../live/liveConfig";

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
  settings: TradingSettings;
  status: ExecutionStatus;
}

export interface ExecutionCoordinatorDependencies {
  paper?: ExecutionAdapter;
  live?: ExecutionAdapter;
  getLiveAdapter?: (humanApproved?: boolean) => Promise<ExecutionAdapter | null>;
  getSettings?: () => Promise<TradingSettings>;
  saveSettings?: (settings: TradingSettings) => Promise<void>;
  getLiveControls?: () => Promise<LiveControls>;
  setLiveControls?: (controls: LiveControls) => Promise<void>;
  getOutstandingRisk?: () => Promise<OutstandingExecutionRisk>;
  getLiveOperations?: () => Promise<LiveOperations>;
  runLivePreflight?: (humanApproved?: boolean) => Promise<LiveReadiness>;
  stopLive?: () => Promise<void>;
  privateWs?: { health(): PrivateWsHealth };
  reconciliation?: { health(): { configured: boolean; running: boolean; lastRunAt: number | null } };
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

async function defaultLiveControls(): Promise<LiveControls> {
  const db = getDb();
  const rows = await db.select().from(liveControls).where(eq(liveControls.id, 1)).limit(1);
  if (rows[0]) return { armed: rows[0].armed };
  await db.insert(liveControls).values({ id: 1, ...DEFAULT_LIVE_CONTROLS })
    .onDuplicateKeyUpdate({ set: { id: 1 } });
  return { ...DEFAULT_LIVE_CONTROLS };
}

async function defaultSetLiveControls(
  controls: LiveControls,
  assertCurrentAdmission: AssertCurrentLiveAdmission,
): Promise<void> {
  await setLiveArmed(getDb(), controls.armed, assertCurrentAdmission);
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

async function defaultDatabaseOutstandingRisk(): Promise<OutstandingExecutionRisk> {
  const db = getDb();
  const [paperRows, liveRows, counts] = await Promise.all([
    db.select({ id: positions.id }).from(positions).where(eq(positions.status, "OPEN")),
    db.select({ id: livePositions.id }).from(livePositions).where(eq(livePositions.status, "OPEN")),
    getOutstandingOrderCounts(),
  ]);
  return { openPositions: paperRows.length + liveRows.length, ...counts };
}

export class ExecutionCoordinator {
  private readonly consumedMomentumSignals = new Set<string>();
  private readonly dependencies: ExecutionCoordinatorDependencies;
  private openSwitchTail: Promise<void> = Promise.resolve();
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

  private liveSupported(): boolean {
    return this.dependencies.live !== undefined || this.dependencies.getLiveAdapter !== undefined;
  }

  private async adapter(settings: TradingSettings, humanApproved = false): Promise<ExecutionAdapter> {
    if (settings.executionMode === "PAPER") return this.paper;
    if (this.marketSource === "TESTNET") throw new Error("TESTNET 行情禁止选择 LIVE_MAINNET");
    if (this.dependencies.live) return this.dependencies.live;
    const live = await this.dependencies.getLiveAdapter?.(humanApproved);
    if (!live) throw new Error("LIVE_MAINNET adapter 尚未配置");
    return live;
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

  private async currentPreflight(humanApproved = false): Promise<LiveReadiness> {
    if (!this.dependencies.runLivePreflight) {
      return { ready: false, reasons: ["主网预检未配置"], checkedAt: null };
    }
    try {
      const result = await this.dependencies.runLivePreflight(humanApproved);
      const checkedAt = result.checkedAt === null ? Number.NaN : Date.parse(result.checkedAt);
      if (result.ready && (!Number.isFinite(checkedAt) || checkedAt > this.now() || this.now() - checkedAt > 10_000)) {
        return { ready: false, reasons: [...result.reasons, "预检结果缺少有效新鲜时间"], checkedAt: result.checkedAt };
      }
      return result;
    } catch {
      return { ready: false, reasons: ["当前主网预检调用失败"], checkedAt: null };
    }
  }

  private currentAdmissionGuard(): AssertCurrentLiveAdmission {
    return createLiveAdmissionGuard(
      this.dependencies.env ?? process.env,
      () => this.currentPreflight(),
      () => this.now(),
    );
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
      if (!this.liveSupported()) return { ok: false, reason: "LIVE_MAINNET adapter 尚未配置" };
      const preflight = await this.currentPreflight();
      if (!preflight.ready) return { ok: false, reason: `主网预检未通过：${preflight.reasons.join("；") || "未知原因"}` };
      const current = await this.status();
      const blocking = current.reasons.filter((reason) => !(manualCanary && reason.startsWith("自动交易已暂停")));
      if (blocking.length > 0) return { ok: false, reason: `当前主网门控未通过：${blocking.join("；")}` };
    }

    if (guardedMomentumSignal && opportunity.expiryTime <= this.now()) {
      return { ok: false, reason: "动量信号已过期" };
    }
    if (guardedMomentumSignal && this.consumedMomentumSignals.has(opportunity.signalId)) {
      return { ok: false, reason: "动量信号已执行" };
    }
    if (guardedMomentumSignal) this.consumedMomentumSignals.add(opportunity.signalId);
    try {
      const selectedAdapter = await this.adapter(settings);
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
    return (await this.adapter(await this.settings())).close(positionId, reason);
  }

  async manage(): Promise<void> {
    const adapter = (await this.adapter(await this.settings()));
    await adapter.manage();
    await this.manageMomentumExits();
  }

  async manageMomentumExits(): Promise<void> {
    const settings = await this.settings();
    const adapter = await this.adapter(settings);
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
    return (await this.adapter(await this.settings())).emergency();
  }

  async account(): Promise<AccountSnapshot> {
    return (await this.adapter(await this.settings())).account();
  }

  async positions(): Promise<PositionView[]> {
    return (await this.adapter(await this.settings())).positions();
  }

  async snapshot(): Promise<ExecutionSnapshot> {
    return (await this.adapter(await this.settings())).snapshot();
  }

  private buildStatus(
    settings: TradingSettings,
    controls: LiveControls,
    outstanding: OutstandingExecutionRisk,
    operations: LiveOperations,
    positions: PositionView[],
    preflight: LiveReadiness,
    adapterConfigured: boolean,
  ): ExecutionStatus {
    const env = this.dependencies.env ?? process.env;
    const environmentEnabled = liveTradingEnabled(env);
    const credentialsConfigured = getLivePublicStatus(env).credentialsConfigured;
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
    const privateWs = this.dependencies.privateWs?.health() ?? {
      configured: false,
      running: false,
      connected: false,
      lastMessageAt: null,
      reconnects: 0,
    };
    const privateWsFresh = privateWs.lastMessageAt !== null && this.now() >= privateWs.lastMessageAt
      && this.now() - privateWs.lastMessageAt <= 10_000;
    const privateWsHealthy = privateWs.configured && privateWs.running && privateWs.connected && privateWsFresh;
    const issueSummary = operations.reconciliationSummary;
    const reconciliationState = this.dependencies.reconciliation?.health() ?? {
      configured: false,
      running: false,
      lastRunAt: null,
    };
    const reconciliationFresh = reconciliationState.lastRunAt !== null && this.now() >= reconciliationState.lastRunAt
      && this.now() - reconciliationState.lastRunAt <= 10_000;
    const reconciliationHealthy = reconciliationState.configured && reconciliationState.running
      && reconciliationFresh && issueSummary.severeIssues === 0;
    const missingProtections = settings.executionMode === "LIVE_MAINNET"
      ? positions.filter((position) => !operations.protectionOrders.some((order) => order.intentId === position.id
        && order.type === "STOP_MARKET" && order.reduceOnly && ["NEW", "PARTIALLY_FILLED"].includes(order.status)))
        .map((position) => `${position.symbol} 缺少有效止损保护`)
      : [];
    const healthReasons: string[] = [];
    if (!privateWsHealthy) healthReasons.push("私有 WS 未连接或消息不新鲜");
    if (!reconciliationHealthy) healthReasons.push("对账未运行、已陈旧或存在严重问题");
    if (settings.momentumEnabled && !frameFresh) healthReasons.push("动量检测无新鲜有效特征帧");
    if (missingProtections.length > 0) healthReasons.push(...missingProtections);
    const reasons: string[] = [];
    if (settings.executionMode === "LIVE_MAINNET") {
      if (this.marketSource === "TESTNET") reasons.push("TESTNET 行情禁止真实执行");
      if (!environmentEnabled) reasons.push("LIVE_TRADING_ENABLED 未开启");
      if (!credentialsConfigured) reasons.push("主网凭据未配置");
      if (!controls.armed) reasons.push("主网执行未 armed");
      if (!adapterConfigured) reasons.push("LIVE_MAINNET adapter 尚未配置");
      if (!preflight.ready) reasons.push(...preflight.reasons);
      reasons.push(...healthReasons);
      if (!settings.autoTrade) reasons.push("自动交易已暂停（手动 canary 不受影响）");
    }
    const effectivePreflightReady = preflight.ready && healthReasons.length === 0;
    return {
      executionMode: settings.executionMode,
      armed: controls.armed,
      environmentEnabled,
      credentialsConfigured,
      adapterConfigured,
      canSubmit: settings.executionMode === "LIVE_MAINNET" && reasons.length === 0,
      reasons,
      preflight: {
        ...preflight,
        ready: effectivePreflightReady,
        reasons: effectivePreflightReady ? preflight.reasons : [...new Set([...preflight.reasons, ...healthReasons])],
      },
      momentum,
      outstanding,
      reconciliation: {
        configured: reconciliationState.configured,
        running: reconciliationState.running,
        healthy: reconciliationHealthy,
        openIssues: issueSummary.openIssues,
        severeIssues: issueSummary.severeIssues,
        lastRunAt: reconciliationState.lastRunAt === null ? null : new Date(reconciliationState.lastRunAt).toISOString(),
        lastDetectedAt: issueSummary.lastDetectedAt === null ? null : new Date(issueSummary.lastDetectedAt).toISOString(),
      },
      privateWs,
      missingProtections,
    };
  }

  private statusPreflight(
    settings: TradingSettings,
    controls: LiveControls,
    adapterConfigured: boolean,
  ): Promise<LiveReadiness> {
    const env = this.dependencies.env ?? process.env;
    const basicGates = settings.executionMode === "LIVE_MAINNET" && controls.armed
      && adapterConfigured && liveTradingEnabled(env)
      && getLivePublicStatus(env).credentialsConfigured;
    if (basicGates) return this.currentPreflight();
    return Promise.resolve({
      ready: false,
      reasons: [settings.executionMode === "PAPER" ? "PAPER 模式无需主网预检" : "基础门控未满足，未执行主网预检"],
      checkedAt: null,
    });
  }

  async status(): Promise<ExecutionStatus> {
    const settings = await this.settings();
    const controls = await (this.dependencies.getLiveControls ?? defaultLiveControls)();
    let selectedAdapter: ExecutionAdapter | null = null;
    try {
      selectedAdapter = await this.adapter(settings);
    } catch {
      if (settings.executionMode === "PAPER") throw new Error("PAPER adapter 不可用");
    }
    const positionPromise = selectedAdapter?.positions() ?? Promise.resolve([]);
    const [operations, outstanding, positions] = await Promise.all([
      (this.dependencies.getLiveOperations ?? defaultLiveOperations)(),
      this.dependencies.getOutstandingRisk?.() ?? defaultOutstandingRisk(positionPromise),
      positionPromise,
    ]);
    const adapterConfigured = settings.executionMode === "LIVE_MAINNET" && selectedAdapter !== null;
    const preflight = await this.statusPreflight(settings, controls, adapterConfigured);
    return this.buildStatus(settings, controls, outstanding, operations, positions, preflight, adapterConfigured);
  }

  async dashboard(): Promise<ExecutionDashboard> {
    const settings = await this.settings();
    const controls = await (this.dependencies.getLiveControls ?? defaultLiveControls)();
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
    let selectedAdapter: ExecutionAdapter | null = null;
    try {
      selectedAdapter = await this.adapter(settings);
    } catch {
      if (settings.executionMode === "PAPER") throw new Error("PAPER adapter 不可用");
    }
    const snapshot = selectedAdapter ? await selectedAdapter.snapshot() : unavailableSnapshot;
    const operations = await (this.dependencies.getLiveOperations ?? defaultLiveOperations)();
    const outstanding = this.dependencies.getOutstandingRisk
      ? await this.dependencies.getOutstandingRisk()
      : await defaultOutstandingRisk(Promise.resolve(snapshot.positions));
    const adapterConfigured = settings.executionMode === "LIVE_MAINNET" && selectedAdapter !== null;
    const preflight = await this.statusPreflight(settings, controls, adapterConfigured);
    return {
      ...snapshot,
      ...operations,
      settings,
      status: this.buildStatus(settings, controls, outstanding, operations, snapshot.positions, preflight, adapterConfigured),
    };
  }

  async setArmed(armed: boolean): Promise<ExecutionStatus> {
    return this.serializeOpenSwitch(async () => {
      if (armed) {
        const settings = await this.settings();
        if (settings.executionMode !== "LIVE_MAINNET") throw new Error("只有 LIVE_MAINNET 模式可以 armed");
        if (this.marketSource === "TESTNET") throw new Error("TESTNET 行情禁止 armed");
        const env = this.dependencies.env ?? process.env;
        if (!liveTradingEnabled(env)) throw new Error("LIVE_TRADING_ENABLED 未开启");
        if (!getLivePublicStatus(env).credentialsConfigured) throw new Error("主网凭据未配置");
        if (!this.liveSupported()) throw new Error("LIVE_MAINNET adapter 尚未配置");
        const preflight = await this.currentPreflight(true);
        if (!preflight.ready) throw new Error(`主网预检未通过：${preflight.reasons.join("；") || "未知原因"}`);
      }
      if (this.dependencies.setLiveControls) await this.dependencies.setLiveControls({ armed });
      else await defaultSetLiveControls({ armed }, this.currentAdmissionGuard());
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
    let risk: OutstandingExecutionRisk;
    if (this.dependencies.getOutstandingRisk) {
      risk = await this.dependencies.getOutstandingRisk();
    } else {
      const selectedAdapter = settings.executionMode === "PAPER" ? this.paper
        : this.dependencies.live ?? await this.dependencies.getLiveAdapter?.() ?? null;
      risk = selectedAdapter
        ? await defaultOutstandingRisk(selectedAdapter.positions())
        : await defaultDatabaseOutstandingRisk();
    }
    if (risk.openPositions > 0 || risk.pendingIntents > 0 || risk.unfinishedOrders > 0) {
      throw new Error("存在未结持仓、意图或未完成订单，禁止切换执行模式");
    }
    const next = { ...settings, executionMode };
    if (this.dependencies.saveSettings) await this.dependencies.saveSettings(next);
    else await switchExecutionModeAtomic(executionMode);
    if (executionMode === "PAPER") await this.dependencies.stopLive?.();
    return next;
  }
}

export function createExecutionCoordinator(dependencies: ExecutionCoordinatorDependencies = {}) {
  return new ExecutionCoordinator(dependencies);
}

export const executionCoordinator = createExecutionCoordinator({
  market: binance,
  getLiveAdapter: (humanApproved) => productionLiveRuntime.getLiveAdapter(humanApproved),
  runLivePreflight: (humanApproved) => productionLiveRuntime.runLivePreflight(humanApproved),
  stopLive: () => productionLiveRuntime.stop(),
  privateWs: productionLiveRuntime.privateWs,
  reconciliation: productionLiveRuntime.reconciliation,
});
