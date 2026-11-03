import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ExecutionMode, type Opportunity } from "@contracts/trading";
import { createExecutionCoordinator, type ExecutionAdapter } from "../services/executionCoordinator";
import { createProductionLiveRuntime, type ProductionLiveServices } from "./productionRuntime";

function adapter(): ExecutionAdapter {
  const snapshot = async () => ({
    account: {
      equity: 1, cash: 1, availableMargin: 1, usedMargin: 0, unrealizedPnl: 0,
      realizedPnl: 0, todayPnl: 0, todayPnlPct: 0, dayStartEquity: 1,
      valuationValid: true, valuationIssues: [], dailyLocked: false,
    },
    positions: [],
  });
  return {
    open: async () => ({ ok: false, reason: "fake adapter" }),
    close: async () => ({ ok: false, reason: "fake adapter", unsettled: false, alreadyClosed: true, pnl: undefined }),
    tightenStop: async () => ({ ok: true, changed: false, reason: "fake adapter" }),
    manage: async () => undefined,
    emergency: async () => ({ ok: true, paused: true, settled: [], unsettled: [] }),
    account: async () => (await snapshot()).account,
    positions: async () => [],
    snapshot,
  };
}

function services(): ProductionLiveServices {
  return {
    adapter: adapter(),
    start: async () => undefined,
    stop: async () => undefined,
    preflight: async () => ({ ready: true, reasons: [], checkedAt: new Date(1_800_000_000_000).toISOString() }),
    privateWs: { health: () => ({ configured: true, running: true, connected: true, lastMessageAt: 1_800_000_000_000, reconnects: 0 }) },
    reconciliation: { health: () => ({ configured: true, running: true, lastRunAt: 1_800_000_000_000 }) },
  };
}

function setup(options: {
  executionMode?: ExecutionMode;
  env?: Record<string, string | undefined>;
  armed?: boolean;
  outstanding?: boolean;
  createServices?: () => ProductionLiveServices;
  storedCredentials?: boolean;
} = {}) {
  const settings = { ...DEFAULT_SETTINGS, executionMode: options.executionMode ?? "LIVE_MAINNET" };
  const runtime = createProductionLiveRuntime({
    env: options.env ?? {
      LIVE_TRADING_ENABLED: "true",
      BINANCE_MAINNET_API_KEY: "fake-key",
      BINANCE_MAINNET_API_SECRET: "fake-secret",
    },
    getSettings: async () => settings,
    getLiveControls: async () => ({ armed: options.armed ?? false }),
    hasOutstandingLiveRisk: async () => options.outstanding ?? false,
    credentialsConfigured: options.storedCredentials === undefined
      ? undefined : async () => options.storedCredentials === true,
    createServices: options.createServices ?? services,
  });
  return { runtime, settings };
}

describe("production live runtime gates", () => {
  it("PAPER never constructs live services even with credentials and human approval", async () => {
    const createServices = vi.fn(services);
    const h = setup({ executionMode: "PAPER", armed: true, createServices });

    await expect(h.runtime.getLiveAdapter(true)).resolves.toBeNull();
    expect(createServices).not.toHaveBeenCalled();
  });

  it.each([
    { name: "environment", env: { BINANCE_MAINNET_API_KEY: "fake", BINANCE_MAINNET_API_SECRET: "fake" } },
    { name: "credentials", env: { LIVE_TRADING_ENABLED: "true" } },
  ])("missing $name gate fails closed without construction", async ({ env }) => {
    const createServices = vi.fn(services);
    const h = setup({ armed: true, env, createServices });

    await expect(h.runtime.getLiveAdapter()).resolves.toBeNull();
    expect(createServices).not.toHaveBeenCalled();
    expect(h.runtime.privateWs.health().configured).toBe(false);
  });

  it("unarmed LIVE starts read-only account access while order submission remains blocked", async () => {
    const created = services();
    const start = vi.fn(created.start);
    const open = vi.fn(created.adapter.open);
    created.start = start;
    created.adapter.open = open;
    const h = setup({ createServices: () => created });
    const coordinator = createExecutionCoordinator({
      getSettings: async () => h.settings,
      getLiveControls: async () => ({ armed: false }),
      getLiveAdapter: h.runtime.getLiveAdapter,
      runLivePreflight: h.runtime.runLivePreflight,
      getLiveOperations: async () => ({
        orders: [], protectionOrders: [], unsettledIntents: [], reconciliationIssues: [],
        reconciliationSummary: { openIssues: 0, severeIssues: 0, lastDetectedAt: null },
      }),
      getOutstandingRisk: async () => ({ openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 }),
      credentialsConfigured: async () => true,
      env: { LIVE_TRADING_ENABLED: "true" },
    });

    await expect(coordinator.snapshot()).resolves.toMatchObject({ account: { equity: 1 }, positions: [] });
    expect(start).toHaveBeenCalledTimes(1);

    const signal: Opportunity = {
      id: "BTCUSDT-LONG", signalId: "test-only", strategyType: "SWING", symbol: "BTCUSDT", side: "LONG",
      status: "READY", score: 90, regime: "多头共振", entry: 100, stop: 99, target: 103,
      stopDistancePct: 1, rewardRisk: 3, leverage: 2, marginPct: 2, riskPct: 0.35,
      reasons: ["测试信号"], signalCloseTime: 1_800_000_000_000, signalTime: 1_800_000_000_000,
      expiryTime: 1_800_000_015_000, triggerPrice: 100, limitPrice: 100.1, stateVersion: 0,
      sourceGeneration: 0, detectorVersion: "test", configVersion: "test", atr15: 1,
      createdAt: new Date(1_800_000_000_000).toISOString(),
    };
    await expect(coordinator.open(signal)).resolves.toEqual({ ok: false, reason: "主网执行未 armed" });
    expect(open).not.toHaveBeenCalled();
    await h.runtime.stop();
  });

  it("accepts stored credential status without env credentials while preserving every other gate", async () => {
    const createServices = vi.fn(services);
    const h = setup({
      env: { LIVE_TRADING_ENABLED: "true" },
      armed: true,
      storedCredentials: true,
      createServices,
    });

    await expect(h.runtime.getLiveAdapter()).resolves.not.toBeNull();
    expect(createServices).toHaveBeenCalledTimes(1);
  });

  it("explicit arming approval constructs and starts one shared lifecycle", async () => {
    const created = services();
    const start = vi.fn(created.start);
    created.start = start;
    const createServices = vi.fn(() => created);
    const h = setup({ createServices });

    const first = await h.runtime.getLiveAdapter(true);
    const second = await h.runtime.getLiveAdapter(true);
    expect(first).toBe(created.adapter);
    expect(second).toBe(created.adapter);
    expect(createServices).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    await expect(h.runtime.runLivePreflight(true)).resolves.toMatchObject({ ready: true });
    expect(h.runtime.privateWs.health().connected).toBe(true);
    expect(h.runtime.reconciliation.health().running).toBe(true);
  });

  it("persisted armed and outstanding recovery can use the same adapter after disarm", async () => {
    const createServices = vi.fn(services);
    let armed = true;
    const outstanding = false;
    const runtime = createProductionLiveRuntime({
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake", BINANCE_MAINNET_API_SECRET: "fake" },
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" }),
      getLiveControls: async () => ({ armed }),
      hasOutstandingLiveRisk: async () => outstanding,
      createServices,
    });

    const initial = await runtime.getLiveAdapter();
    armed = false;
    expect(await runtime.getLiveAdapter()).toBe(initial);
    expect(createServices).toHaveBeenCalledTimes(1);
  });

  it("unarmed restart with outstanding live risk enables recovery without opening new entries", async () => {
    const createServices = vi.fn(services);
    const h = setup({ outstanding: true, createServices });

    await expect(h.runtime.getLiveAdapter()).resolves.not.toBeNull();
    expect(createServices).toHaveBeenCalledTimes(1);
  });

  it("failed startup closes partial services and is not cached as configured", async () => {
    let attempts = 0;
    let stops = 0;
    const h = setup({
      armed: true,
      createServices: () => {
        attempts += 1;
        const current = services();
        current.start = async () => { throw new Error("fake startup failure"); };
        current.stop = async () => { stops += 1; };
        return current;
      },
    });

    await expect(h.runtime.getLiveAdapter()).rejects.toThrow("fake startup failure");
    expect(h.runtime.privateWs.health().configured).toBe(false);
    expect(stops).toBe(1);
    await expect(h.runtime.getLiveAdapter()).rejects.toThrow("fake startup failure");
    expect(attempts).toBe(2);
    expect(stops).toBe(2);
  });

  it("shutdown during startup waits for and closes the partial lifecycle before retrying", async () => {
    let release!: () => void;
    let stops = 0;
    let creates = 0;
    const created = services();
    const active = services();
    created.start = () => new Promise<void>((resolve) => { release = resolve; });
    created.stop = async () => { stops += 1; };
    const h = setup({ armed: true, createServices: () => ++creates === 1 ? created : active });

    const starting = h.runtime.getLiveAdapter(true);
    await vi.waitFor(() => expect(release).toBeDefined());
    const stopping = h.runtime.stop();
    release();
    await expect(starting).resolves.toBe(active.adapter);
    await stopping;

    expect(stops).toBe(1);
    expect(h.runtime.privateWs.health().connected).toBe(true);
    await h.runtime.stop();
  });

  it("retries when shutdown overlaps deferred startup instead of returning the stopped adapter", async () => {
    let releaseStart!: () => void;
    let stops = 0;
    const stopped = services();
    const active = services();
    stopped.start = () => new Promise<void>((resolve) => { releaseStart = resolve; });
    stopped.stop = async () => { stops += 1; };
    let creates = 0;
    const h = setup({ armed: true, createServices: () => ++creates === 1 ? stopped : active });

    const starting = h.runtime.getLiveAdapter(true);
    await vi.waitFor(() => expect(releaseStart).toBeDefined());
    const stopping = h.runtime.stop();
    releaseStart();

    await expect(starting).resolves.toBe(active.adapter);
    await stopping;
    expect(stops).toBe(1);
    expect(creates).toBe(2);
    expect(h.runtime.privateWs.health().connected).toBe(true);
    await h.runtime.stop();
  });

  it("restart during shutdown waits for cleanup and retains the new lifecycle", async () => {
    const first = services();
    const second = services();
    let releaseStop!: () => void;
    let stopEntered = false;
    first.stop = () => new Promise<void>((resolve) => {
      stopEntered = true;
      releaseStop = resolve;
    });
    let creates = 0;
    const h = setup({ armed: true, createServices: () => ++creates === 1 ? first : second });

    await h.runtime.getLiveAdapter(true);
    const stopping = h.runtime.stop();
    await vi.waitFor(() => expect(stopEntered).toBe(true));
    const restarting = h.runtime.getLiveAdapter(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(creates).toBe(1);

    releaseStop();
    await stopping;
    await expect(restarting).resolves.toBe(second.adapter);
    expect(h.runtime.privateWs.health().connected).toBe(true);
    expect(creates).toBe(2);
    await h.runtime.stop();
  });
});
