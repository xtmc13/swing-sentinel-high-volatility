import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AccountSnapshot } from "@contracts/trading";
import { createExecutionCoordinator, type ExecutionAdapter } from "./executionCoordinator";

const account: AccountSnapshot = {
  equity: 100,
  cash: 100,
  availableMargin: 100,
  usedMargin: 0,
  unrealizedPnl: 0,
  realizedPnl: 0,
  todayPnl: 0,
  todayPnlPct: 0,
  dayStartEquity: 100,
  valuationValid: true,
  valuationIssues: [],
  dailyLocked: false,
};

function adapter(label: string): ExecutionAdapter {
  const snapshot = async () => ({ account: { ...account, cash: label === "paper" ? 100 : 200 }, positions: [] });
  return {
    open: async () => ({ ok: false, reason: "test only" }),
    close: async () => ({ ok: false, reason: "test only", unsettled: false, alreadyClosed: true, pnl: undefined }),
    manage: async () => undefined,
    emergency: async () => ({ ok: true, paused: true, settled: [], unsettled: [] }),
    account: async () => (await snapshot()).account,
    positions: async () => [],
    snapshot,
  };
}

const emptyOperations = {
  orders: [],
  protectionOrders: [],
  unsettledIntents: [],
  reconciliationIssues: [],
  reconciliationSummary: { openIssues: 0, severeIssues: 0, lastDetectedAt: null },
};

function setup(options: {
  executionMode?: "PAPER" | "LIVE_MAINNET";
  armed?: boolean;
  live?: ExecutionAdapter;
  getLiveAdapter?: (humanApproved?: boolean) => Promise<ExecutionAdapter | null>;
  runLivePreflight?: (humanApproved?: boolean) => Promise<{ ready: boolean; reasons: string[]; checkedAt: string | null }>;
} = {}) {
  let armed = options.armed ?? false;
  const settings = { ...DEFAULT_SETTINGS, executionMode: options.executionMode ?? "PAPER" };
  const coordinator = createExecutionCoordinator({
    paper: adapter("paper"),
    live: options.live,
    getLiveAdapter: options.getLiveAdapter,
    getSettings: async () => settings,
    getLiveControls: async () => ({ armed }),
    setLiveControls: async (next) => { armed = next.armed; },
    getLiveOperations: async () => emptyOperations,
    getOutstandingRisk: async () => ({ openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 }),
    runLivePreflight: options.runLivePreflight,
    env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake", BINANCE_MAINNET_API_SECRET: "fake" },
  });
  return { coordinator, settings };
}

describe("lazy production live adapter", () => {
  it("PAPER account never resolves live services", async () => {
    const getLiveAdapter = vi.fn(async () => adapter("live"));
    const h = setup({ getLiveAdapter });

    await expect(h.coordinator.account()).resolves.toMatchObject({ cash: 100 });
    await expect(h.coordinator.status()).resolves.toMatchObject({ executionMode: "PAPER", adapterConfigured: false });
    expect(getLiveAdapter).not.toHaveBeenCalled();
  });

  it("unavailable LIVE adapter returns a failed-closed dashboard instead of PAPER data", async () => {
    const h = setup({ executionMode: "LIVE_MAINNET", getLiveAdapter: async () => null });

    const dashboard = await h.coordinator.dashboard();
    expect(dashboard.account.valuationValid).toBe(false);
    expect(dashboard.account.cash).not.toBe(100);
    expect(dashboard.status.adapterConfigured).toBe(false);
    expect(dashboard.status.canSubmit).toBe(false);
  });

  it("armed LIVE status resolves the real adapter and reports it configured", async () => {
    const h = setup({ executionMode: "LIVE_MAINNET", armed: true, getLiveAdapter: async () => adapter("live") });

    const dashboard = await h.coordinator.dashboard();
    expect(dashboard.account.cash).toBe(200);
    expect(dashboard.status.adapterConfigured).toBe(true);
  });

  it("arming passes explicit human approval to preflight before persisting armed", async () => {
    const approvals: boolean[] = [];
    const h = setup({
      executionMode: "LIVE_MAINNET",
      getLiveAdapter: async () => adapter("live"),
      runLivePreflight: async (humanApproved) => {
        approvals.push(humanApproved === true);
        return { ready: true, reasons: [], checkedAt: new Date().toISOString() };
      },
    });

    await h.coordinator.setArmed(true);
    expect(approvals).toEqual([true, false]);
  });
});
