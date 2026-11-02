import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIVE_CONTROLS,
  DEFAULT_SETTINGS,
  type AccountSnapshot,
  type Opportunity,
  type PositionView,
  type TradingSettings,
} from "@contracts/trading";
import {
  createExecutionCoordinator,
  liveTradingEnabled,
  type ExecutionAdapter,
} from "./executionCoordinator";

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
  risk?: { openPositions: number; pendingIntents: number; unfinishedOrders: number };
  riskLoader?: () => Promise<{ openPositions: number; pendingIntents: number; unfinishedOrders: number }>;
  now?: () => number;
} = {}) {
  const settings: TradingSettings = { ...DEFAULT_SETTINGS, autoTrade: true, ...options.settings };
  const paper = options.paper ?? adapter();
  const live = options.live ?? adapter();
  const saveSettings = vi.fn(async (next: TradingSettings) => {
    Object.assign(settings, next);
  });
  const coordinator = createExecutionCoordinator({
    paper,
    live,
    getSettings: async () => settings,
    saveSettings,
    getLiveControls: async () => ({ armed: options.armed ?? false }),
    getOutstandingRisk: options.riskLoader ?? (async () => options.risk ?? { openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 }),
    market: { dataSource: options.source ?? "MAINNET" },
    env: options.env ?? {},
    now: options.now ?? (() => 1_800_000_001_000),
  });
  return { coordinator, settings, paper, live, saveSettings };
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
      env: { LIVE_TRADING_ENABLED: "true" },
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
    { name: "armed", env: { LIVE_TRADING_ENABLED: "true" }, armed: false, autoTrade: true },
    { name: "autoTrade", env: { LIVE_TRADING_ENABLED: "true" }, armed: true, autoTrade: false },
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
      env: { LIVE_TRADING_ENABLED: "true" },
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

  it("120 秒无跟随通过现有 coordinator close 退出，同时保留原持仓管理", async () => {
    const stagnant = {
      ...position,
      entryPrice: 100,
      markPrice: 100,
      openedAt: new Date(1_799_999_880_999).toISOString(),
    };
    const paper = adapter({
      open: vi.fn(async () => ({ ok: true as const, positionId: stagnant.id, reason: "模拟开仓成交" })),
      positions: vi.fn(async () => [stagnant]),
    });
    const h = setup({
      settings: { momentumEnabled: true, strategyMode: "MOMENTUM" },
      paper,
    });
    const signal = opportunity({ strategyType: "MOMENTUM", breakoutPrice: 99 });
    await h.coordinator.open(signal);

    await h.coordinator.manage();

    expect(paper.manage).toHaveBeenCalledTimes(1);
    expect(paper.close).toHaveBeenCalledWith(stagnant.id, "120 秒无跟随退出");
  });

  it("跌回突破位且流向反转通过现有 close 退出，未结算时不重复平仓", async () => {
    const failed = {
      ...position,
      entryPrice: 100.02,
      markPrice: 99.99,
      openedAt: new Date(1_800_000_001_000).toISOString(),
    };
    const paper = adapter({
      open: vi.fn(async () => ({ ok: true as const, positionId: failed.id, reason: "模拟开仓成交" })),
      positions: vi.fn(async () => [failed]),
      close: vi.fn(async () => ({ ok: true as const, reason: "等待平仓", pnl: Number.NaN, unsettled: true as const, alreadyClosed: false as const })),
    });
    const h = setup({ settings: { momentumEnabled: true, strategyMode: "MOMENTUM" }, paper });
    await h.coordinator.open(opportunity({ strategyType: "MOMENTUM", breakoutPrice: 100 }));
    h.coordinator.observeMomentumFrame({
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

    await h.coordinator.manage();
    await h.coordinator.manage();

    expect(paper.close).toHaveBeenCalledTimes(1);
    expect(paper.close).toHaveBeenCalledWith(failed.id, "跌回突破位且流向反转");
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
});
