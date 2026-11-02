import { afterAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AccountSnapshot } from "@contracts/trading";

const SECRET = "execution-router-admin-secret-with-32-characters";
process.env.APP_SECRET = SECRET;

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => ({ ok: true as const, reason: "人工平仓", pnl: 0, unsettled: false as const, alreadyClosed: false as const })),
  emergency: vi.fn(async () => ({ ok: true, paused: true as const, settled: [], unsettled: [] })),
  paperClose: vi.fn(),
  paperEmergency: vi.fn(),
  paperReset: vi.fn(async () => ({ ok: true, paused: true as const, settled: [], unsettled: [] })),
  saveSettings: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
}));

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

vi.mock("./services/executionCoordinator", () => ({
  executionCoordinator: {
    close: mocks.close,
    emergency: mocks.emergency,
    snapshot: vi.fn(async () => ({ account, positions: [] })),
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
    req: new Request("http://localhost/api/trpc", { headers: { authorization: `Bearer ${SECRET}` } }),
    resHeaders: new Headers(),
  });
}

afterAll(() => { delete process.env.APP_SECRET; });

describe("统一执行管理入口", () => {
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
});
