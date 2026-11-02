import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIVE_CONTROLS,
  DEFAULT_SETTINGS,
  type AccountSnapshot,
  type Opportunity,
  type PositionView,
  type PrivateWsHealth,
  type TradingSettings,
} from "@contracts/trading";
import {
  createExecutionCoordinator,
  liveTradingEnabled,
  type ExecutionAdapter,
} from "./executionCoordinator";
import { InMemoryMomentumStateStore } from "./momentumState";

const account: AccountSnapshot = {
  equity: 100_000,
  cash: 100_000,
  availableMargin: 100_000,
  usedMargin: 0,
  unrealizedPnl: 0,
  realizedPnl: 0,
  todayPnl: 0,
  todayPnlPct: 0,
  dayStartEquity: 100_000,
  valuationValid: true,
  valuationIssues: [],
  dailyLocked: false,
};

const position: PositionView = {
  id: crypto.randomUUID(),
  symbol: "BTCUSDT",
  side: "LONG",
  qty: 1,
  initialQty: 1,
  entryPrice: 100,
  markPrice: 101,
  stopPrice: 99,
  targetPrice: 103,
  liquidationPrice: 90,
  leverage: 2,
  margin: 50,
  unrealizedPnl: 1,
  unrealizedPct: 2,
  realizedPnl: 0,
  openedAt: new Date(1_800_000_000_000).toISOString(),
  holdingMinutes: 1,
  rMultiple: 0.5,
  valuationValid: true,
};

function reversalFrame() {
  return {
    symbol: "BTCUSDT",
    event_time: 1_800_000_000_990,
    received_time: 1_800_000_001_000,
    sequence: 3,
    generation: 4,
    quality: "GOOD" as const,
    config_hash: "a".repeat(64),
    mark_price: 99.99,
    microprice: 99.99,
    spread_bps: 1,
    depth_imbalance: -0.2,
    aggressive_buy_volume: 1,
    aggressive_sell_volume: 3,
    short_return: -0.001,
    burst_z: 2.5,
    realized_volatility: 0.02,
  };
}

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "BTCUSDT-LONG",
    signalId: "swing:BTCUSDT:LONG:1800000000000:0:0",
    strategyType: "SWING",
    symbol: "BTCUSDT",
    side: "LONG",
    status: "READY",
    score: 90,
    regime: "多头共振",
    entry: 100,
    stop: 99,
    target: 103,
    stopDistancePct: 1,
    rewardRisk: 3,
    leverage: 2,
    marginPct: 2,
    riskPct: 0.35,
    reasons: ["测试信号"],
    signalCloseTime: 1_800_000_000_000,
    signalTime: 1_800_000_000_000,
    expiryTime: 1_800_000_015_000,
    triggerPrice: 100,
    limitPrice: 100.1,
    stateVersion: 0,
    sourceGeneration: 0,
    detectorVersion: "swing-closed-candle-v1",
    configVersion: "swing-config-v1",
    atr15: 1,
    createdAt: new Date(1_800_000_000_000).toISOString(),
    ...overrides,
  };
}

function adapter(overrides: Partial<ExecutionAdapter> = {}): ExecutionAdapter {
  return {
    open: vi.fn(async () => ({ ok: true as const, positionId: "paper-position", reason: "模拟开仓成交" })),
    close: vi.fn(async () => ({ ok: true as const, reason: "人工平仓", pnl: 1, unsettled: false as const, alreadyClosed: false as const })),
    manage: vi.fn(async () => undefined),
    emergency: vi.fn(async () => ({ ok: true, paused: true as const, settled: [], unsettled: [] })),
    account: vi.fn(async () => account),
    positions: vi.fn(async () => [position]),
    snapshot: vi.fn(async () => ({ account, positions: [position] })),
    ...overrides,
  };
}

function setup(options: {
  settings?: Partial<TradingSettings>;
  source?: "MAINNET" | "TESTNET";
  paper?: ExecutionAdapter;
  live?: ExecutionAdapter;
  env?: Record<string, string | undefined>;
  armed?: boolean;
  preflight?: { ready: boolean; reasons: string[]; checkedAt: string | null };
  operations?: {
    orders: { id: string; intentId: string; clientOrderId: string; exchangeOrderId: string | null; symbol: string; side: "LONG" | "SHORT"; type: "LIMIT" | "MARKET" | "STOP_MARKET"; status: string; price: string; originalQuantity: string; executedQuantity: string; averagePrice: string; commission: string; reduceOnly: boolean; createdAt: string }[];
    protectionOrders: { id: string; intentId: string; clientOrderId: string; exchangeOrderId: string | null; symbol: string; side: "LONG" | "SHORT"; type: "LIMIT" | "MARKET" | "STOP_MARKET"; status: string; price: string; originalQuantity: string; executedQuantity: string; averagePrice: string; commission: string; reduceOnly: boolean; createdAt: string }[];
    unsettledIntents: { id: string; symbol: string; status: string }[];
    reconciliationIssues: { id: string; category: string; severity: "INFO" | "WARN" | "ERROR" | "CRITICAL"; status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED"; symbol: string | null; message: string; detectedAt: string }[];
    reconciliationSummary: { openIssues: number; severeIssues: number; lastDetectedAt: number | null };
  };
  privateWs?: { health(): PrivateWsHealth };
  reconciliation?: { health(): { configured: boolean; running: boolean; lastRunAt: number | null } };
  risk?: { openPositions: number; pendingIntents: number; unfinishedOrders: number };
  riskLoader?: () => Promise<{ openPositions: number; pendingIntents: number; unfinishedOrders: number }>;
  now?: () => number;
  momentumStore?: InMemoryMomentumStateStore;
} = {}) {
  const settings: TradingSettings = { ...DEFAULT_SETTINGS, autoTrade: true, ...options.settings };
  const paper = options.paper ?? adapter();
  const live = options.live ?? adapter();
  const momentumStore = options.momentumStore ?? new InMemoryMomentumStateStore();
  let armed = options.armed ?? false;
  const saveSettings = vi.fn(async (next: TradingSettings) => {
    Object.assign(settings, next);
  });
  const setLiveControls = vi.fn(async (next: { armed: boolean }) => { armed = next.armed; });
  const runLivePreflight = vi.fn(async () => options.preflight ?? {
    ready: true,
    reasons: [],
    checkedAt: new Date(1_800_000_001_000).toISOString(),
  });
  const confirmedStop = {
    id: "confirmed-stop", intentId: position.id, clientOrderId: "confirmed-stop", exchangeOrderId: "1",
    symbol: position.symbol, side: "SHORT" as const, type: "STOP_MARKET" as const, status: "NEW",
    price: "99", originalQuantity: "1", executedQuantity: "0", averagePrice: "0", commission: "0",
    reduceOnly: true, createdAt: new Date(1_800_000_000_000).toISOString(),
  };
  const coordinator = createExecutionCoordinator({
    paper,
    live,
    getSettings: async () => settings,
    saveSettings,
    getLiveControls: async () => ({ armed }),
    setLiveControls,
    runLivePreflight,
    getLiveOperations: async () => options.operations ?? {
      orders: [], protectionOrders: [confirmedStop], unsettledIntents: [], reconciliationIssues: [],
      reconciliationSummary: { openIssues: 0, severeIssues: 0, lastDetectedAt: null },
    },
    privateWs: options.privateWs ?? { health: () => ({ configured: true, running: true, connected: true, lastMessageAt: 1_800_000_001_000, reconnects: 0 }) },
    reconciliation: options.reconciliation ?? { health: () => ({ configured: true, running: true, lastRunAt: 1_800_000_001_000 }) },
    getOutstandingRisk: options.riskLoader ?? (async () => options.risk ?? { openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 }),
    market: { dataSource: options.source ?? "MAINNET" },
    env: options.env ?? {},
    now: options.now ?? (() => 1_800_000_001_000),
    momentumStore,
  });
  return { coordinator, settings, paper, live, saveSettings, setLiveControls, runLivePreflight, momentumStore };
}

describe("执行配置安全默认值", () => {
  it("默认仅启用 SWING paper，动量、主网总开关和 armed 全部关闭", () => {
    expect(DEFAULT_SETTINGS.executionMode).toBe("PAPER");
    expect(DEFAULT_SETTINGS.strategyMode).toBe("SWING");
    expect(DEFAULT_SETTINGS.momentumEnabled).toBe(false);
    expect(DEFAULT_LIVE_CONTROLS.armed).toBe(false);
    expect(liveTradingEnabled({})).toBe(false);
    expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: "false" })).toBe(false);
  });
});

describe("ExecutionCoordinator", () => {
  it("PAPER 开仓保留原 paper adapter 调用和结果", async () => {
    const h = setup({ source: "TESTNET" });
    const signal = opportunity();
    const healthy = () => true;

    const result = await h.coordinator.open(signal, healthy);

    expect(result).toEqual({ ok: true, positionId: "paper-position", reason: "模拟开仓成交" });
    expect(h.paper.open).toHaveBeenCalledWith(signal, healthy);
    expect(h.live.open).not.toHaveBeenCalled();
  });

  it("统一 paper 的 close/manage/emergency/account/positions/snapshot 行为", async () => {
    const h = setup();

    await expect(h.coordinator.close(position.id)).resolves.toMatchObject({ ok: true, pnl: 1 });
    await expect(h.coordinator.manage()).resolves.toBeUndefined();
    await expect(h.coordinator.emergency()).resolves.toMatchObject({ ok: true, paused: true });
    await expect(h.coordinator.account()).resolves.toBe(account);
    await expect(h.coordinator.positions()).resolves.toEqual([position]);
    await expect(h.coordinator.snapshot()).resolves.toEqual({ account, positions: [position] });
    expect(h.paper.close).toHaveBeenCalledWith(position.id, undefined);
    expect(h.paper.manage).toHaveBeenCalledTimes(1);
    expect(h.paper.emergency).toHaveBeenCalledTimes(1);
  });

  it("TESTNET 行情不能切换或选择 LIVE_MAINNET", async () => {
    const h = setup({ source: "TESTNET" });

    await expect(h.coordinator.switchExecutionMode("LIVE_MAINNET")).rejects.toThrow("TESTNET");
    expect(h.saveSettings).not.toHaveBeenCalled();
    Object.assign(h.settings, { executionMode: "LIVE_MAINNET" });
    await expect(h.coordinator.open(opportunity())).resolves.toMatchObject({ ok: false });
    expect(h.live.open).not.toHaveBeenCalled();
    await expect(h.coordinator.close(position.id)).rejects.toThrow("TESTNET");
    expect(h.live.close).not.toHaveBeenCalled();
  });

  it.each([
    { openPositions: 1, pendingIntents: 0, unfinishedOrders: 0 },
    { openPositions: 0, pendingIntents: 1, unfinishedOrders: 0 },
    { openPositions: 0, pendingIntents: 0, unfinishedOrders: 1 },
  ])("有未结风险时拒绝切换执行模式：%j", async (risk) => {
    const h = setup({ risk });

    await expect(h.coordinator.switchExecutionMode("LIVE_MAINNET")).rejects.toThrow("未结");
    expect(h.saveSettings).not.toHaveBeenCalled();
  });

  it("无未结风险时可通过专用方法切换模式", async () => {
    const h = setup();

    await expect(h.coordinator.switchExecutionMode("LIVE_MAINNET")).resolves.toMatchObject({
      executionMode: "LIVE_MAINNET",
    });
    expect(h.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("switch 检查到写入期间 open 不能进入 adapter，完成后按新模式执行", async () => {
    let riskStarted!: () => void;
    const riskCheckStarted = new Promise<void>((resolve) => { riskStarted = resolve; });
    let releaseRisk!: () => void;
    const riskRelease = new Promise<void>((resolve) => { releaseRisk = resolve; });
    const order: string[] = [];
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      armed: true,
      riskLoader: async () => {
        order.push("risk");
        riskStarted();
        await riskRelease;
        return { openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 };
      },
    });
    h.saveSettings.mockImplementation(async (next) => {
      order.push("save");
      Object.assign(h.settings, next);
    });
    vi.mocked(h.paper.open).mockImplementation(async () => {
      order.push("paper-open");
      return { ok: true as const, positionId: "paper-position", reason: "模拟开仓成交" };
    });
    vi.mocked(h.live.open).mockImplementation(async () => {
      order.push("live-open");
      return { ok: true as const, positionId: "live-position", reason: "不应提前开仓" };
    });

    const switching = h.coordinator.switchExecutionMode("PAPER");
    await riskCheckStarted;
    const opening = h.coordinator.open(opportunity());
    await new Promise((resolve) => setImmediate(resolve));
    const earlyAdapterCalls = vi.mocked(h.paper.open).mock.calls.length + vi.mocked(h.live.open).mock.calls.length;
    releaseRisk();
    await switching;
    const result = await opening;

    expect(earlyAdapterCalls).toBe(0);
    expect(order).toEqual(["risk", "save", "paper-open"]);
    expect(result).toMatchObject({ ok: true, positionId: "paper-position" });
  });

  it.each([
    { name: "总开关", env: {}, armed: true, autoTrade: true },
    { name: "armed", env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" }, armed: false, autoTrade: true },
    { name: "autoTrade", env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" }, armed: true, autoTrade: false },
  ])("缺少 $name 条件时 live 开仓失败关闭", async (gate) => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET", autoTrade: gate.autoTrade },
      env: gate.env,
      armed: gate.armed,
    });

    await expect(h.coordinator.open(opportunity())).resolves.toMatchObject({ ok: false });
    expect(h.live.open).not.toHaveBeenCalled();
  });

  it("全部 live 门控满足时才委托 live adapter", async () => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      armed: true,
    });
    const signal = opportunity();

    await expect(h.coordinator.open(signal)).resolves.toMatchObject({ ok: true });
    expect(h.live.open).toHaveBeenCalledWith(signal, undefined);
    expect(h.paper.open).not.toHaveBeenCalled();
  });

  it("默认关闭或 SWING-only 时，动量信号不能直接进入 adapter", async () => {
    const disabled = setup();
    const signal = opportunity({ strategyType: "MOMENTUM" });

    await expect(disabled.coordinator.open(signal)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("关闭") });
    expect(disabled.paper.open).not.toHaveBeenCalled();

    const swingOnly = setup({ settings: { momentumEnabled: true, strategyMode: "SWING" } });
    await expect(swingOnly.coordinator.open(signal)).resolves.toMatchObject({ ok: false });
    expect(swingOnly.paper.open).not.toHaveBeenCalled();
  });

  it("重启后仅凭持久化持仓元数据执行 120 秒无跟随退出", async () => {
    const stagnant: PositionView = {
      ...position,
      signalId: "persisted-momentum",
      strategyType: "MOMENTUM",
      breakoutPrice: 99,
      entryPrice: 100,
      markPrice: 100,
      openedAt: new Date(1_799_999_880_999).toISOString(),
    };
    const paper = adapter({ positions: vi.fn(async () => [stagnant]) });
    const h = setup({ paper });

    await h.coordinator.manage();

    expect(paper.manage).toHaveBeenCalledTimes(1);
    expect(paper.close).toHaveBeenCalledWith(stagnant.id, "120 秒无跟随退出");
  });

  it("非候选反转 frame 立即退出，持久化 pending 在重启后防止重复平仓", async () => {
    const failed: PositionView = {
      ...position,
      signalId: "persisted-momentum",
      strategyType: "MOMENTUM",
      breakoutPrice: 100,
      exitPending: false,
      entryPrice: 100.02,
      markPrice: 100.02,
      openedAt: new Date(1_800_000_001_000).toISOString(),
    };
    const paper = adapter({
      positions: vi.fn(async () => [failed]),
      close: vi.fn(async () => {
        failed.exitPending = true;
        return { ok: true as const, reason: "等待平仓", pnl: Number.NaN, unsettled: true as const, alreadyClosed: false as const };
      }),
    });
    const momentumStore = new InMemoryMomentumStateStore();
    const first = setup({ paper, momentumStore });

    await first.coordinator.receiveMomentumFrame({
      symbol: "BTCUSDT",
      event_time: 1_800_000_000_990,
      received_time: 1_800_000_001_000,
      sequence: 3,
      generation: 4,
      quality: "GOOD",
      config_hash: "a".repeat(64),
      mark_price: 99.99,
      microprice: 99.99,
      spread_bps: 1,
      depth_imbalance: -0.2,
      aggressive_buy_volume: 1,
      aggressive_sell_volume: 3,
      short_return: -0.001,
      burst_z: 2.5,
      realized_volatility: 0.02,
    });

    expect(paper.manage).not.toHaveBeenCalled();
    expect(paper.close).toHaveBeenCalledWith(failed.id, "跌回突破位且流向反转");
    expect(await momentumStore.latestFrame("BTCUSDT")).toMatchObject({ sequence: 3 });

    const restarted = setup({ paper, momentumStore });
    await restarted.coordinator.manage();
    expect(paper.close).toHaveBeenCalledTimes(1);
  });

  it("两个 coordinator 竞争同一退出时只有一个能提交 close", async () => {
    const failed: PositionView = {
      ...position,
      strategyType: "MOMENTUM",
      breakoutPrice: 100,
      entryPrice: 100.02,
      markPrice: 99.99,
      openedAt: new Date(1_800_000_001_000).toISOString(),
      exitPending: false,
    };
    const paper = adapter({
      positions: async () => [failed],
      close: vi.fn(async () => ({ ok: true as const, reason: "等待平仓", pnl: Number.NaN, unsettled: true as const, alreadyClosed: false as const })),
    });
    const momentumStore = new InMemoryMomentumStateStore();
    const first = setup({ paper, momentumStore });
    const second = setup({ paper, momentumStore });

    await Promise.all([
      first.coordinator.receiveMomentumFrame(reversalFrame()),
      second.coordinator.receiveMomentumFrame(reversalFrame()),
    ]);

    expect(paper.close).toHaveBeenCalledTimes(1);
  });

  it("crash 留下 pending 但没有 close order 时，过期 claim 可重试；已有订单则不重发", async () => {
    const failed: PositionView = {
      ...position,
      strategyType: "MOMENTUM",
      breakoutPrice: 100,
      entryPrice: 100.02,
      markPrice: 99.99,
      openedAt: new Date(1_800_000_001_000).toISOString(),
      exitPending: true,
    };
    const paper = adapter({
      positions: async () => [failed],
      close: vi.fn(async () => ({ ok: true as const, reason: "等待平仓", pnl: Number.NaN, unsettled: true as const, alreadyClosed: false as const })),
    });
    const momentumStore = new InMemoryMomentumStateStore();
    await momentumStore.saveFrame(reversalFrame());
    await momentumStore.claimExit(
      "PAPER",
      failed.id,
      "跌回突破位且流向反转",
      "crashed-owner",
      1_800_000_001_000,
      5_000,
    );
    const restarted = setup({ paper, momentumStore, now: () => 1_800_000_006_001 });
    await momentumStore.saveFrame({
      ...reversalFrame(),
      event_time: 1_800_000_006_000,
      received_time: 1_800_000_006_001,
      sequence: 4,
    });

    await restarted.coordinator.manage();
    expect(paper.close).toHaveBeenCalledTimes(1);

    await restarted.coordinator.manage();
    expect(paper.close).toHaveBeenCalledTimes(1);
  });

  it("过期动量信号和重复 signalId 不进入 adapter", async () => {
    const h = setup({ settings: { momentumEnabled: true, strategyMode: "MOMENTUM" } });
    const signal = opportunity({ strategyType: "MOMENTUM" });

    await expect(h.coordinator.open({ ...signal, expiryTime: 1_800_000_000_999 })).resolves.toMatchObject({ ok: false });
    expect(h.paper.open).not.toHaveBeenCalled();

    await h.coordinator.open(signal);
    await expect(h.coordinator.open(signal)).resolves.toMatchObject({ ok: false });
    expect(h.paper.open).toHaveBeenCalledTimes(1);
  });

  it("手动 canary 只绕过 autoTrade，预检失败仍拒绝提交", async () => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET", autoTrade: false },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      armed: true,
    });
    const signal = opportunity();

    await expect(h.coordinator.openManual(signal)).resolves.toMatchObject({ ok: true });
    expect(h.live.open).toHaveBeenCalledWith(signal, undefined, { manualCanary: true });

    const failed = setup({
      settings: { executionMode: "LIVE_MAINNET", autoTrade: false },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      armed: true,
      preflight: { ready: false, reasons: ["私有 WS 未连接"], checkedAt: null },
    });
    await expect(failed.coordinator.openManual(signal)).resolves.toEqual({ ok: false, reason: "主网预检未通过：私有 WS 未连接" });
    expect(failed.live.open).not.toHaveBeenCalled();
  });

  it("armed 只在环境总开关和完整预检通过后持久化，disarm 不依赖预检", async () => {
    const blocked = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      env: {},
      preflight: { ready: true, reasons: [], checkedAt: null },
    });
    await expect(blocked.coordinator.setArmed(true)).rejects.toThrow("LIVE_TRADING_ENABLED");
    expect(blocked.setLiveControls).not.toHaveBeenCalled();
    expect(blocked.runLivePreflight).not.toHaveBeenCalled();

    const h = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
    });
    await expect(h.coordinator.setArmed(true)).resolves.toMatchObject({ armed: true });
    expect(h.setLiveControls).toHaveBeenCalledWith({ armed: true });
    await expect(h.coordinator.setArmed(false)).resolves.toMatchObject({ armed: false });
    expect(h.runLivePreflight).toHaveBeenCalledTimes(2);
  });

  it("状态复用 MAINNET 凭据公共配置且只报告布尔值", async () => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "not-a-real-key", BINANCE_MAINNET_API_SECRET: "not-a-real-secret" },
      armed: true,
    });

    const status = await h.coordinator.status();
    expect(status).toMatchObject({ executionMode: "LIVE_MAINNET", armed: true, environmentEnabled: true, credentialsConfigured: true });
    expect(JSON.stringify(status)).not.toContain("not-a-real-key");
    expect(JSON.stringify(status)).not.toContain("not-a-real-secret");
  });

  it("当前预检、私有 WS、对账、动量或保护不健康时 canSubmit 失败关闭", async () => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET", momentumEnabled: true, strategyMode: "BOTH" },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      armed: true,
      preflight: { ready: true, reasons: [], checkedAt: new Date(1_799_999_900_000).toISOString() },
      privateWs: { health: () => ({ configured: true, running: true, connected: true, lastMessageAt: 1_799_999_900_000, reconnects: 0 }) },
      reconciliation: { health: () => ({ configured: true, running: false, lastRunAt: 1_799_999_900_000 }) },
      operations: { orders: [], protectionOrders: [], unsettledIntents: [], reconciliationIssues: [], reconciliationSummary: { openIssues: 0, severeIssues: 0, lastDetectedAt: null } },
    });

    const status = await h.coordinator.status();
    expect(h.runLivePreflight).toHaveBeenCalledTimes(1);
    expect(status.preflight.ready).toBe(false);
    expect(status.canSubmit).toBe(false);
    expect(status.reconciliation).toMatchObject({ running: false, healthy: false });
    expect(status.reasons.join("；")).toContain("私有 WS");
    expect(status.reasons.join("；")).toContain("对账");
    expect(status.reasons.join("；")).toContain("动量");
    expect(status.missingProtections).toContain("BTCUSDT 缺少有效止损保护");
  });

  it.each([
    { status: "PENDING_SEND", reduceOnly: true },
    { status: "SUBMITTING", reduceOnly: true },
    { status: "UNKNOWN", reduceOnly: true },
    { status: "RECONCILING", reduceOnly: true },
    { status: "NEW", reduceOnly: false },
  ])("未确认或非 reduceOnly 止损不算保护：%j", async ({ status: orderStatus, reduceOnly }) => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      operations: {
        orders: [],
        unsettledIntents: [],
        reconciliationIssues: [],
        reconciliationSummary: { openIssues: 0, severeIssues: 0, lastDetectedAt: null },
        protectionOrders: [{
          id: "stop-1", intentId: position.id, clientOrderId: "stop-1", exchangeOrderId: null,
          symbol: position.symbol, side: "SHORT", type: "STOP_MARKET", status: orderStatus,
          price: "99", originalQuantity: "1", executedQuantity: "0", averagePrice: "0",
          commission: "0", reduceOnly, createdAt: new Date(1_800_000_000_000).toISOString(),
        }],
      },
    });

    expect((await h.coordinator.status()).missingProtections).toContain("BTCUSDT 缺少有效止损保护");
  });

  it("显示分页之外的未解决严重问题仍阻断 readiness", async () => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      armed: true,
      operations: {
        orders: [], protectionOrders: [], unsettledIntents: [], reconciliationIssues: [],
        reconciliationSummary: { openIssues: 102, severeIssues: 1, lastDetectedAt: 1_800_000_001_000 },
      },
    });

    const status = await h.coordinator.status();
    expect(status.reconciliation).toMatchObject({ healthy: false, openIssues: 102, severeIssues: 1 });
    expect(status.canSubmit).toBe(false);
  });

  it("LIVE adapter 未配置时 dashboard 显示不可用而不回退 paper 账户", async () => {
    const paper = adapter();
    const coordinator = createExecutionCoordinator({
      paper,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" }),
      getLiveControls: async () => ({ armed: false }),
      getLiveOperations: async () => ({ orders: [], protectionOrders: [], unsettledIntents: [], reconciliationIssues: [], reconciliationSummary: { openIssues: 0, severeIssues: 0, lastDetectedAt: null } }),
      getOutstandingRisk: async () => ({ openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 }),
      env: {},
      market: { dataSource: "MAINNET" },
    });

    const dashboard = await coordinator.dashboard();
    expect(dashboard.status).toMatchObject({ executionMode: "LIVE_MAINNET", adapterConfigured: false, canSubmit: false });
    expect(dashboard.account.valuationValid).toBe(false);
    expect(dashboard.account.valuationIssues).toContain("LIVE_MAINNET adapter 尚未配置");
    expect(dashboard.positions).toEqual([]);
    expect(paper.snapshot).not.toHaveBeenCalled();
  });
});
