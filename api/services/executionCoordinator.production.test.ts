import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AccountSnapshot, type PositionView, type TradingSettings } from "@contracts/trading";
import { executionIntents, executionOrders, positions } from "@db/schema";
import { createExecutionCoordinator, type ExecutionAdapter } from "./executionCoordinator";

const database = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
}));

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = database.rows.get(table) ?? [];
          return {
            orderBy: async () => rows,
            then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => (
              Promise.resolve(rows).then(resolve, reject)
            ),
          };
        },
      }),
    }),
  }),
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

const openPosition: PositionView = {
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

function adapter(positionRows: PositionView[]): ExecutionAdapter {
  return {
    open: vi.fn(async () => ({ ok: false as const, reason: "测试不下单" })),
    close: vi.fn(async () => ({ ok: false as const, reason: "测试不平仓", unsettled: true as const, alreadyClosed: false as const })),
    manage: vi.fn(async () => undefined),
    emergency: vi.fn(async () => ({ ok: true, paused: true as const, settled: [], unsettled: [] })),
    account: vi.fn(async () => account),
    positions: vi.fn(async () => positionRows),
    snapshot: vi.fn(async () => ({ account, positions: positionRows })),
  };
}

function setup(options: {
  settings?: Partial<TradingSettings>;
  positions?: PositionView[];
  intents?: { status: string }[];
  orders?: { status: string }[];
} = {}) {
  database.rows.clear();
  database.rows.set(positions, []);
  database.rows.set(executionIntents, options.intents ?? []);
  database.rows.set(executionOrders, options.orders ?? []);
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const selectedAdapter = adapter(options.positions ?? []);
  const saveSettings = vi.fn(async () => undefined);
  const coordinator = createExecutionCoordinator({
    paper: selectedAdapter,
    live: selectedAdapter,
    getSettings: async () => settings,
    saveSettings,
    market: { dataSource: "MAINNET" },
  });
  return { coordinator, saveSettings, selectedAdapter };
}

describe("生产默认未结风险查询", () => {
  it("PENDING_SEND intent 阻断切换", async () => {
    const h = setup({
      intents: [{ status: "PENDING_SEND" }, { status: "EXPIRED" }],
    });

    await expect(h.coordinator.switchExecutionMode("LIVE_MAINNET")).rejects.toThrow("未结");
    expect(h.selectedAdapter.positions).toHaveBeenCalledTimes(1);
    expect(h.saveSettings).not.toHaveBeenCalled();
  });

  it("EXPIRED/CANCEL intent/order 都是终态，不阻断空风险切换", async () => {
    const h = setup({
      intents: [{ status: "EXPIRED" }, { status: "CANCEL" }],
      orders: [{ status: "EXPIRED" }, { status: "FILLED" }, { status: "CANCEL" }],
    });

    await expect(h.coordinator.switchExecutionMode("LIVE_MAINNET")).resolves.toMatchObject({
      executionMode: "LIVE_MAINNET",
    });
    expect(h.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("live adapter 的持仓计入风险，不读取 paper positions 代替", async () => {
    const h = setup({
      settings: { executionMode: "LIVE_MAINNET" },
      positions: [openPosition],
    });

    await expect(h.coordinator.switchExecutionMode("PAPER")).rejects.toThrow("未结");
    expect(h.selectedAdapter.positions).toHaveBeenCalledTimes(1);
    expect(h.saveSettings).not.toHaveBeenCalled();
  });
});
