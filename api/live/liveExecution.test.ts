import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Opportunity, type TradingSettings } from "@contracts/trading";
import { liveControls, tradingSettings } from "@db/schema";
import type {
  BinanceAccountResponse,
  BinanceOpenOrder,
  BinanceUserTrade,
  CancelOrderRequest,
  LiveOrderGateway,
  PlaceOrderRequest,
} from "./binanceSigned";
import type {
  ClaimLiveIntentInput,
  CreateLiveIntentInput,
  CreateLiveIntentOptions,
  CreateLiveIntentResult,
  LiveDatabase,
  LiveFinalGateResult,
} from "./livePersistence";
import { createExecutionCoordinator } from "../services/executionCoordinator";
import { InMemoryLiveOrderStore, type LivePositionSeed } from "./orderStateMachine";
import { createMainnetLiveExecutionAdapter, MainnetLiveExecutionAdapter } from "./liveExecution";

class AdapterGateway implements LiveOrderGateway {
  readonly placed: PlaceOrderRequest[] = [];
  readonly cancelled: CancelOrderRequest[] = [];
  private nextOrderId = 500;

  async placeOrder(request: PlaceOrderRequest): Promise<BinanceOpenOrder> {
    this.placed.push(request);
    return {
      symbol: request.symbol,
      orderId: this.nextOrderId++,
      clientOrderId: request.newClientOrderId ?? "generated",
      price: request.price ?? "0",
      origQty: request.quantity,
      executedQty: "0",
      status: "NEW",
      side: request.side,
      type: request.type,
      reduceOnly: request.reduceOnly,
    };
  }

  async cancelOrder(request: CancelOrderRequest): Promise<BinanceOpenOrder> {
    this.cancelled.push(request);
    return {
      symbol: request.symbol,
      orderId: this.nextOrderId++,
      clientOrderId: request.origClientOrderId ?? "generated",
      price: "0",
      origQty: "0",
      executedQty: "0",
      status: "CANCELED",
      side: "SELL",
      type: "LIMIT",
    };
  }

  async queryOrder(): Promise<null> {
    return null;
  }

  async userTrades(): Promise<BinanceUserTrade[]> {
    return [];
  }

  async account(): Promise<BinanceAccountResponse> {
    return { assets: [{ asset: "USDT", walletBalance: "10000", availableBalance: "9000" }] };
  }
}

const opportunity: Opportunity = {
  id: "opportunity-1",
  signalId: "signal-1",
  strategyType: "MOMENTUM",
  symbol: "BTCUSDT",
  side: "LONG",
  status: "READY",
  score: 1,
  regime: "NORMAL",
  entry: 100,
  stop: 99,
  target: 103,
  stopDistancePct: 1,
  rewardRisk: 3,
  leverage: 5,
  marginPct: 2,
  riskPct: 0.35,
  reasons: [],
  signalCloseTime: 1,
  signalTime: 2,
  expiryTime: 9_999_999_999_999,
  triggerPrice: 100,
  limitPrice: 100,
  stateVersion: 1,
  sourceGeneration: 1,
  detectorVersion: "test",
  configVersion: "test",
  createdAt: new Date(1).toISOString(),
};

function seedFor(input: CreateLiveIntentInput): LivePositionSeed {
  return {
    id: input.id,
    symbol: input.symbol,
    side: input.side,
    stopPrice: input.stopPrice,
    liquidationPrice: input.liquidationPrice,
    leverage: String(input.leverage),
    maintenanceBracket: 1,
    maintMarginRatio: "0.01",
    cumMaintenance: "0",
  };
}

function setup() {
  const store = new InMemoryLiveOrderStore();
  const gateway = new AdapterGateway();
  const created: CreateLiveIntentInput[] = [];
  const claims: ClaimLiveIntentInput[] = [];
  const createIntent = vi.fn<(
    input: CreateLiveIntentInput,
    options: CreateLiveIntentOptions,
  ) => Promise<CreateLiveIntentResult>>(async (input, options) => {
    expect(gateway.placed).toHaveLength(0);
    created.push(input);
    const gate = await options.finalGate({} as never);
    expect(gate.approved).toBe(true);
    return { ok: true as const, id: input.id, version: 1 as const, emergencyGeneration: 7 };
  });
  const claimIntent = vi.fn(async (input: ClaimLiveIntentInput) => {
    claims.push(input);
    return { ok: true as const, version: input.expectedVersion + 1 };
  });
  const assertSubmission = vi.fn(async () => undefined);
  const pauseAutoTrade = vi.fn(async () => undefined);
  const adapter = new MainnetLiveExecutionAdapter({
    store,
    gateway,
    workerId: "worker-a",
    createIntent,
    claimIntent,
    assertSubmission,
    pauseAutoTrade,
    prepareIntent: (signal) => ({
      signalId: signal.signalId,
      symbol: signal.symbol,
      side: signal.side,
      quantity: "2",
      limitPrice: "100",
      tickSize: "0.01",
      stopPrice: "99",
      liquidationPrice: "50",
      leverage: 5,
      notional: "200",
      reservedMargin: "40",
      reservedRisk: "2",
      expiresAt: new Date(9_999_999_999_999),
      leaseDurationMs: 5_000,
    }),
    finalGate: (signal): LiveFinalGateResult => ({
      approved: true,
      signalId: signal.signalId,
      quantity: "2",
      notional: "200",
      reservedMargin: "40",
      reservedRisk: "2",
      validUntil: new Date(9_999_999_999_999),
    }),
  });
  return { store, gateway, created, claims, createIntent, claimIntent, assertSubmission, pauseAutoTrade, adapter };
}

describe("mainnet live execution adapter", () => {
  it("persists and claims the intent before IOC submission; acknowledgement alone creates no position", async () => {
    const h = setup();

    const result = await h.adapter.open(opportunity);
    expect(result).toMatchObject({ ok: true, positionId: h.created[0].id });
    expect(h.created).toHaveLength(1);
    expect(h.claims).toHaveLength(1);
    expect(h.createIntent.mock.calls[0]?.[1].requireAutoTrade).toBe(true);
    expect(h.assertSubmission).toHaveBeenCalledWith(h.created[0].id, 7);
    expect(h.gateway.placed[0]).toMatchObject({ type: "LIMIT", timeInForce: "IOC", quantity: "2" });
    expect(await h.store.getPosition(h.created[0].id)).toBeNull();
  });

  it("a duplicate signal rejected by persistence never reaches the transport", async () => {
    const h = setup();
    h.createIntent.mockResolvedValueOnce({ ok: false, reason: "signalId 已存在" });

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: false });
    expect(h.claimIntent).not.toHaveBeenCalled();
    expect(h.gateway.placed).toHaveLength(0);
  });

  it("a changed emergency generation prevents transport", async () => {
    const h = setup();
    h.assertSubmission.mockRejectedValueOnce(new Error("emergency generation changed"));

    await expect(h.adapter.open(opportunity)).rejects.toThrow("generation changed");
    expect(h.gateway.placed).toHaveLength(0);
  });

  it("emergency serializes behind an in-flight open and then cancels its order", async () => {
    const h = setup();
    let release!: (order: BinanceOpenOrder) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    h.gateway.placeOrder = (request) => {
      h.gateway.placed.push(request);
      markStarted();
      return new Promise<BinanceOpenOrder>((resolve) => { release = resolve; });
    };
    const opening = h.adapter.open(opportunity);
    await started;
    const emergency = h.adapter.emergency();
    await Promise.resolve();
    expect(h.pauseAutoTrade).not.toHaveBeenCalled();

    release({
      symbol: "BTCUSDT",
      orderId: 500,
      clientOrderId: `${h.created[0].id}-entry`,
      price: "100",
      origQty: "2",
      executedQty: "0",
      status: "NEW",
      side: "BUY",
      type: "LIMIT",
    });
    await opening;
    await emergency;
    expect(h.pauseAutoTrade).toHaveBeenCalledTimes(1);
    expect(h.gateway.cancelled).toHaveLength(1);
  });

  it("autoTrade=false blocks only new opens; coordinator still permits live reduce-only close", async () => {
    const h = setup();
    let settings: TradingSettings = { ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", autoTrade: true };
    const coordinator = createExecutionCoordinator({
      live: h.adapter,
      getSettings: async () => settings,
      getLiveControls: async () => ({ armed: true }),
      env: { LIVE_TRADING_ENABLED: "true" },
      market: { dataSource: "MAINNET" },
    });
    await coordinator.open(opportunity);
    await h.adapter.handleFill(`${h.created[0].id}-entry`, {
      exchangeTradeId: "adapter-fill",
      exchangeOrderId: "500",
      symbol: "BTCUSDT",
      side: "BUY",
      price: "100",
      quantity: "2",
      commission: "0.1",
      commissionAsset: "USDT",
      realizedPnl: "0",
      isMaker: false,
      executedAt: 10,
    }, seedFor(h.created[0]));
    settings = { ...settings, autoTrade: false };

    await expect(coordinator.open({ ...opportunity, signalId: "signal-2" })).resolves.toMatchObject({ ok: false });
    const beforeClose = h.gateway.placed.length;
    const result = await coordinator.close(h.created[0].id);
    expect(result.unsettled).toBe(true);
    expect(h.gateway.placed.length).toBe(beforeClose + 1);
    expect(h.gateway.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true, side: "SELL" });
  });

  it("live emergency pauses auto trading and paper reset is disabled", async () => {
    const h = setup();

    const emergency = await h.adapter.emergency();
    expect(emergency).toMatchObject({ ok: true, paused: true, unsettled: [] });
    expect(h.pauseAutoTrade).toHaveBeenCalledTimes(1);
    await expect(h.adapter.resetPaperSimulation()).rejects.toThrow("禁止 paper reset");
  });

  it("production factory emergency pauses autoTrade and increments generation through the live database", async () => {
    const updates: { table: unknown; values: { autoTrade?: boolean } }[] = [];
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            for: async () => table === tradingSettings ? [{ id: 1 }] : table === liveControls ? [{ generation: 0 }] : [],
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: { autoTrade?: boolean }) => ({
          where: async () => { updates.push({ table, values }); },
        }),
      }),
    };
    const db = {
      transaction: async (operation: (transaction: unknown) => Promise<void>) => operation(tx),
    } as unknown as LiveDatabase;
    const adapter = createMainnetLiveExecutionAdapter({
      db,
      store: new InMemoryLiveOrderStore(),
      gateway: new AdapterGateway(),
      workerId: "worker-a",
      prepareIntent: () => { throw new Error("not used"); },
      finalGate: () => { throw new Error("not used"); },
    });

    await adapter.emergency();
    expect(updates.find((update) => update.table === tradingSettings)?.values).toEqual({ autoTrade: false });
    expect(updates.some((update) => update.table === liveControls)).toBe(true);
  });
});
