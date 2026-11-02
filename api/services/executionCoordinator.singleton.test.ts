import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";

const runtime = vi.hoisted(() => ({
  getLiveAdapter: vi.fn(),
  runLivePreflight: vi.fn(),
  privateWs: { health: vi.fn() },
  reconciliation: { health: vi.fn() },
  stop: vi.fn(),
}));

vi.mock("../live/productionRuntime", () => ({
  createProductionLiveRuntime: () => runtime,
}));

vi.mock("../queries/trading", async (importActual) => ({
  ...await importActual<typeof import("../queries/trading")>(),
  getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" }),
}));

import { executionCoordinator } from "./executionCoordinator";

describe("production coordinator singleton", () => {
  it("uses the gated production runtime for LIVE account access", async () => {
    runtime.getLiveAdapter.mockResolvedValue({
      account: async () => ({
        equity: 200, cash: 200, availableMargin: 200, usedMargin: 0, unrealizedPnl: 0,
        realizedPnl: 0, todayPnl: 0, todayPnlPct: 0, dayStartEquity: 200,
        valuationValid: true, valuationIssues: [], dailyLocked: false,
      }),
    });

    await expect(executionCoordinator.account()).resolves.toMatchObject({ cash: 200 });
    expect(runtime.getLiveAdapter).toHaveBeenCalledWith(false);
  });
});
