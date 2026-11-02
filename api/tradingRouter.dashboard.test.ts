import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Market, type WebSocketHealthMetrics } from "@contracts/trading";
import type { PositionRow } from "./services/paper";

const mocks = vi.hoisted(() => ({
  getMarketSnapshot: vi.fn(),
}));

vi.mock("./services/binance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/binance")>();
  return {
    ...actual,
    binance: {
      dataSource: "TESTNET",
      sourceLabel: "测试网",
      isConnected: false,
      getMarketSnapshot: mocks.getMarketSnapshot,
    },
  };
});

vi.mock("./services/engine", () => ({
  engine: {
    markets: [],
    opportunities: [],
    lastScanAt: null,
    refreshMarkets: vi.fn(),
    engineState: vi.fn(async () => "DEGRADED"),
    getDashboardObservability: vi.fn(),
  },
}));

vi.mock("./queries/trading", () => ({
  getSettings: vi.fn(),
  getAccount: vi.fn(),
  saveSettings: vi.fn(),
  getOpenPositions: vi.fn(),
  getRecentTrades: vi.fn(async () => []),
  getRecentOrders: vi.fn(async () => []),
  getRecentEvents: vi.fn(async () => []),
  getEquityHistory: vi.fn(async () => []),
  addEvent: vi.fn(),
  ensureInitialized: vi.fn(),
  assertAffectedRows: vi.fn(),
  settingsFromRow: vi.fn(),
}));

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

const NOW = Date.UTC(2026, 0, 2);
const staleMarket: Market = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  price: 101,
  markPrice: 101,
  change24h: 0,
  quoteVolume: 1_000_000_000,
  spreadBps: 1,
  fundingRate: 0,
  high24h: 102,
  low24h: 99,
  maxLeverage: 20,
  liquidityScore: 100,
  eligible: true,
  filterReason: "",
};
const openRow: PositionRow = {
  id: crypto.randomUUID(),
  signalId: null,
  strategyType: "SWING",
  breakoutPrice: null,
  exitPending: false,
  exitReason: null,
  symbol: "BTCUSDT",
  side: "LONG",
  status: "OPEN",
  initialQty: 1,
  qty: 1,
  entryPrice: 100,
  stopPrice: 98,
  targetPrice: 110,
  liquidationPrice: 90,
  leverage: 20,
  margin: 5,
  fees: 0,
  fundingPnl: 0,
  realizedPnl: 0,
  maxFavorableR: 0,
  initialRisk: 2,
  openedAt: new Date(NOW),
  updatedAt: new Date(NOW),
  closedAt: null,
};
const accountRow = {
  id: 1,
  initialBalance: 100_000,
  cash: 100_000,
  realizedPnl: 0,
  dayStartEquity: 100_000,
  dayKey: new Date().toISOString().slice(0, 10),
  dailyLockDay: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
};
const monitor: WebSocketHealthMetrics = {
  running: false,
  source: "TESTNET",
  sourceHealthy: false,
  connections: 0,
  openConnections: 0,
  reconnects: 0,
  messages: 0,
  malformedMessages: 0,
  missedMessages: null,
  rateLimits: 0,
  degradedSymbols: 1,
  lastMessageAt: null,
  averageLatencyMs: null,
  maxLatencyMs: null,
};

const { engine } = await import("./services/engine");
const queries = await import("./queries/trading");
const { getDb } = await import("./queries/connection");
const { tradingRouter } = await import("./tradingRouter");

describe("dashboard 持仓估值", () => {
  it("缓存市场价格仍有效时也不用它掩盖新鲜行情质量失败", async () => {
    vi.mocked(engine.markets).splice(0, engine.markets.length, staleMarket);
    vi.mocked(engine.getDashboardObservability).mockReturnValue({ states: [], quality: {}, monitor });
    vi.mocked(queries.getSettings).mockResolvedValue(DEFAULT_SETTINGS);
    vi.mocked(queries.getOpenPositions).mockResolvedValue([openRow]);
    vi.mocked(queries.getAccount).mockResolvedValue(accountRow);
    mocks.getMarketSnapshot.mockResolvedValue({
      source: "TESTNET",
      symbol: "BTCUSDT",
      bid: 0,
      ask: 0,
      mid: 0,
      markPrice: 101,
      spreadBps: 0,
      bookTime: 0,
      markTime: 0,
      observedAt: NOW,
      quality: { valid: false, reasons: ["行情中断"], bookAgeMs: null, markAgeMs: null, candleAgeMs: null },
    });
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ for: vi.fn(async () => [accountRow]) }),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: vi.fn(async () => undefined) }) }),
    };
    vi.mocked(getDb).mockReturnValue({
      transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    } as never);

    const data = await tradingRouter.createCaller({
      req: new Request("http://localhost/api/trpc"),
      resHeaders: new Headers(),
    }).dashboard();

    expect(data.account.valuationValid).toBe(false);
    expect(data.positions).toHaveLength(1);
    expect(data.positions[0].valuationValid).toBe(false);
    expect(data.positions[0].markPrice).toBeNaN();
    expect(data.positions[0].unrealizedPnl).toBeNaN();
    expect(data.portfolioRisk.totalRiskPct).toBeNaN();
    expect(mocks.getMarketSnapshot).toHaveBeenCalledTimes(1);
  });
});
