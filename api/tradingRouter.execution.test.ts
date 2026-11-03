import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => ({ ok: true as const, reason: "人工平仓", pnl: 0, unsettled: false as const, alreadyClosed: false as const })),
  emergency: vi.fn(async () => ({ ok: true, paused: true as const, settled: [], unsettled: [] })),
  paperClose: vi.fn(),
  paperEmergency: vi.fn(),
  paperReset: vi.fn(async () => ({ ok: true, paused: true as const, settled: [], unsettled: [] })),
  saveSettings: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  dashboard: vi.fn(async () => ({
    account: {},
    positions: [],
    settings: { ...DEFAULT_SETTINGS },
    status: { executionMode: "PAPER", armed: false },
    orders: [],
    unsettledIntents: [],
    reconciliationIssues: [],
  })),
  switchExecutionMode: vi.fn(async (executionMode: "PAPER" | "LIVE_MAINNET") => ({ ...DEFAULT_SETTINGS, executionMode })),
  setArmed: vi.fn(async (armed: boolean) => ({ executionMode: "LIVE_MAINNET", armed })),
  openManual: vi.fn(async () => ({ ok: true as const, positionId: crypto.randomUUID(), reason: "等待真实成交" })),
}));

vi.mock("./services/executionCoordinator", () => ({
  executionCoordinator: {
    close: mocks.close,
    emergency: mocks.emergency,
    dashboard: mocks.dashboard,
    switchExecutionMode: mocks.switchExecutionMode,
    setArmed: mocks.setArmed,
    openManual: mocks.openManual,
  },
}));

vi.mock("./services/paper", async (importOriginal) => ({
  ...await importOriginal<typeof import("./services/paper")>(),
  closePaperPosition: mocks.paperClose,
  emergencyStop: mocks.paperEmergency,
  resetPaperSimulation: mocks.paperReset,
}));

vi.mock("./services/binance", () => ({
  binance: {
    dataSource: "TESTNET",
    sourceLabel: "测试网",
    isConnected: true,
    sourceGeneration: 0,
  },
}));

vi.mock("./services/engine", () => ({
  engine: {
    markets: [],
    opportunities: [],
    lastScanAt: null,
    refreshMarkets: vi.fn(),
    engineState: vi.fn(async () => "PAUSED"),
    getDashboardObservability: vi.fn(() => ({
      states: [],
      quality: {},
      monitor: {
        running: true,
        source: "TESTNET",
        sourceHealthy: true,
        connections: 1,
        openConnections: 1,
        reconnects: 0,
        messages: 1,
        malformedMessages: 0,
        missedMessages: 0,
        rateLimits: 0,
        degradedSymbols: 0,
        lastMessageAt: 1,
        averageLatencyMs: 1,
        maxLatencyMs: 1,
      },
    })),
  },
}));

vi.mock("./queries/trading", () => ({
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
  getAccount: vi.fn(async () => ({ initialBalance: 100_000 })),
  getRecentTrades: vi.fn(async () => []),
  getRecentOrders: vi.fn(async () => []),
  getRecentEvents: vi.fn(async () => []),
  getEquityHistory: vi.fn(async () => []),
}));

vi.mock("./queries/connection", () => ({ getDb: vi.fn() }));

const { tradingRouter, settingsInput } = await import("./tradingRouter");

function caller() {
  return tradingRouter.createCaller({
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  });
}

describe("统一执行公共入口", () => {
  it("close 和 emergency 只通过 coordinator", async () => {
    const positionId = crypto.randomUUID();

    await expect(caller().closePosition({ positionId })).resolves.toMatchObject({ ok: true });
    await expect(caller().emergencyStop()).resolves.toMatchObject({ ok: true });
    expect(mocks.close).toHaveBeenCalledWith(positionId);
    expect(mocks.emergency).toHaveBeenCalledTimes(1);
    expect(mocks.paperClose).not.toHaveBeenCalled();
    expect(mocks.paperEmergency).not.toHaveBeenCalled();
  });

  it("普通保存不能开启主网或 armed，并允许独立动量配置", async () => {
    const parsed = settingsInput.parse({
      ...DEFAULT_SETTINGS,
      executionMode: "LIVE_MAINNET",
      liveControls: { armed: true },
      armed: true,
      strategyMode: "BOTH",
      momentumEnabled: true,
    });

    expect(parsed).not.toHaveProperty("executionMode");
    expect(parsed).not.toHaveProperty("liveControls");
    expect(parsed).not.toHaveProperty("armed");
    expect(parsed.strategyMode).toBe("BOTH");
    expect(parsed.momentumEnabled).toBe(true);

    await caller().saveSettings({
      ...DEFAULT_SETTINGS,
      executionMode: "LIVE_MAINNET",
      liveControls: { armed: true },
      strategyMode: "BOTH",
      momentumEnabled: true,
    } as never);
    expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: "PAPER",
      strategyMode: "BOTH",
      momentumEnabled: true,
    }));
  });

  it("LIVE_MAINNET 禁止 paper reset，PAPER 行为保持不变", async () => {
    mocks.paperReset.mockClear();
    await expect(caller().reset()).resolves.toMatchObject({ ok: true });
    expect(mocks.paperReset).toHaveBeenCalledTimes(1);

    mocks.getSettings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" });
    await expect(caller().reset()).rejects.toThrow("禁止 paper reset");
    expect(mocks.paperReset).toHaveBeenCalledTimes(1);
  });

  it("无管理员令牌或 adminSecret 也可 armed，但仍需精确确认短语，disarm 保持可用", async () => {
    await expect(caller().setLiveControls({ armed: true, confirmationPhrase: "wrong" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.setArmed).not.toHaveBeenCalled();

    await expect(caller().setLiveControls({ armed: true, confirmationPhrase: "ARM LIVE MAINNET" }))
      .resolves.toMatchObject({ armed: true });
    expect(mocks.setArmed).toHaveBeenLastCalledWith(true);
    await expect(caller().setLiveControls({ armed: false })).resolves.toMatchObject({ armed: false });
    expect(mocks.setArmed).toHaveBeenLastCalledWith(false);
  });

  it("manual canary 无 adminSecret 仍需独立确认，只调用 openManual 且不开启自动交易", async () => {
    mocks.saveSettings.mockClear();
    mocks.openManual.mockClear();
    const input = {
      symbol: "BTCUSDT", side: "LONG" as const, limitPrice: 100.004, stopPrice: 99,
      confirmationPhrase: "SUBMIT LIVE CANARY",
    };
    await expect(caller().manualCanary({ ...input, confirmationPhrase: "wrong" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.openManual).not.toHaveBeenCalled();

    await expect(caller().manualCanary(input)).resolves.toMatchObject({ ok: true });
    expect(mocks.openManual).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "BTCUSDT", side: "LONG", strategyType: "SWING", limitPrice: 100.004, stop: 99,
    }));
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("缺失主网门控作为 PRECONDITION_FAILED 拒绝，而不是内部 500", async () => {
    mocks.setArmed.mockRejectedValueOnce(new Error("LIVE_TRADING_ENABLED 未开启"));

    await expect(caller().setLiveControls({ armed: true, confirmationPhrase: "ARM LIVE MAINNET" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "LIVE_TRADING_ENABLED 未开启" });
  });

  it("未知内部错误使用通用消息且不回显配置内容", async () => {
    const sensitive = "mysql://user:password@internal-db/private";
    mocks.setArmed.mockRejectedValueOnce(new Error(sensitive));

    const rejection = await caller().setLiveControls({
      armed: true, confirmationPhrase: "ARM LIVE MAINNET",
    }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "主网控制操作失败" });
    expect(JSON.stringify(rejection)).not.toContain("internal-db");
    expect(JSON.stringify(rejection)).not.toContain("password");
  });

  it("执行模式和 dashboard 都通过 coordinator，并保留 PAPER/LIVE 状态", async () => {
    await expect(caller().setExecutionMode({ executionMode: "LIVE_MAINNET" })).resolves.toMatchObject({ executionMode: "LIVE_MAINNET" });
    expect(mocks.switchExecutionMode).toHaveBeenCalledWith("LIVE_MAINNET");

    await expect(caller().dashboard()).resolves.toMatchObject({ execution: { executionMode: "PAPER", armed: false } });
    expect(mocks.dashboard).toHaveBeenCalled();
  });

  it("dashboard 标签和风险参数使用 coordinator 同一次设置快照", async () => {
    mocks.dashboard.mockResolvedValueOnce({
      account: { equity: 100_000 },
      positions: [],
      settings: { ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" },
      status: { executionMode: "LIVE_MAINNET", armed: false },
      orders: [],
      unsettledIntents: [],
      reconciliationIssues: [],
    });
    mocks.getSettings.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, executionMode: "PAPER" });

    const result = await caller().dashboard();
    expect(result.settings.executionMode).toBe("LIVE_MAINNET");
    expect(result.execution.executionMode).toBe("LIVE_MAINNET");
  });
});
