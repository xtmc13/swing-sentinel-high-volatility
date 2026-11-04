import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Opportunity, type TradingSettings } from "@contracts/trading";
import { liveControls, liveOrders, livePositions, tradingSettings } from "@db/schema";
import { getDb } from "../queries/connection";
import type {
  BinanceAccountResponse,
  BinanceOpenOrder,
  BinancePositionRisk,
  BinanceUserTrade,
  CancelOrderRequest,
  LiveOrderGateway,
  PlaceOrderRequest,
  UserTradesParams,
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
import { DrizzleMomentumStateStore, InMemoryMomentumStateStore } from "../services/momentumState";
import { InMemoryLiveOrderStore, type LivePositionSeed } from "./orderStateMachine";
import { createMainnetLiveExecutionAdapter, MainnetLiveExecutionAdapter } from "./liveExecution";

vi.mock("../queries/connection", () => ({ getDb: vi.fn() }));

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

  async queryOrder(): Promise<BinanceOpenOrder | null> {
    return null;
  }

  async userTrades(_params: UserTradesParams): Promise<BinanceUserTrade[]> {
    void _params;
    return [];
  }

  async account(): Promise<BinanceAccountResponse> {
    return { assets: [{ asset: "USDT", walletBalance: "10000", availableBalance: "9000" }] };
  }

  async positionRisk(): Promise<BinancePositionRisk[]> {
    throw new Error("positionRisk fixture is not connected");
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
  breakoutPrice: 100,
  atr15: 1,
  stateVersion: 1,
  sourceGeneration: 1,
  detectorVersion: "test",
  configVersion: "test",
  createdAt: new Date(1).toISOString(),
};

const ACCOUNT_MODE = { dualSide: false, fingerprint: "0".repeat(64) } as const;

function seedFor(input: CreateLiveIntentInput): LivePositionSeed {
  return {
    id: input.id,
    symbol: input.symbol,
    side: input.side,
    positionSide: input.positionSide,
    entrySemantics: input.entrySemantics,
    accountModeFingerprint: input.accountModeFingerprint,
    stopPrice: input.stopPrice,
    liquidationPrice: input.liquidationPrice,
    leverage: String(input.leverage),
    maintenanceBracket: 1,
    maintMarginRatio: "0.01",
    cumMaintenance: "0",
  };
}

function reversalFrame(eventTime: number, sequence: number) {
  return {
    symbol: "BTCUSDT",
    event_time: eventTime,
    received_time: eventTime + 10,
    sequence,
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

function setup(options: { limitPrice?: string; mode?: "NORMAL" | "HIGH"; autoTrade?: boolean } = {}) {
  const store = new InMemoryLiveOrderStore({ emergencyGeneration: 7, autoTrade: options.autoTrade });
  const gateway = new AdapterGateway();
  const created: CreateLiveIntentInput[] = [];
  const claims: ClaimLiveIntentInput[] = [];
  let finalMode: string | undefined;
  const createIntent = vi.fn<(
    input: CreateLiveIntentInput,
    options: CreateLiveIntentOptions,
  ) => Promise<CreateLiveIntentResult>>(async (input, createOptions) => {
    expect(gateway.placed).toHaveLength(0);
    created.push(input);
    const gate = await createOptions.finalGate({} as never, {
      mode: options.mode ?? "NORMAL",
      highVolatilityRiskMultiplier: 0.5,
    });
    expect(gate.approved).toBe(true);
    return { ok: true as const, id: input.id, version: 1 as const, emergencyGeneration: 7 };
  });
  const claimIntent = vi.fn(async (input: ClaimLiveIntentInput) => {
    claims.push(input);
    return { ok: true as const, version: input.expectedVersion + 1 };
  });
  const pauseAutoTrade = vi.fn(async () => undefined);
  const assertCurrentAdmission = vi.fn(async () => undefined);
  const adapter = new MainnetLiveExecutionAdapter({
    store,
    assertCurrentAdmission,
    gateway,
    userTradesPageLimit: 2,
    workerId: "worker-a",
    accountMode: ACCOUNT_MODE,
    createIntent,
    claimIntent,
    pauseAutoTrade,
    prepareIntent: (signal) => ({
      signalId: signal.signalId,
      symbol: signal.symbol,
      side: signal.side,
      positionSide: signal.side,
      entrySemantics: "ENTRY",
      accountModeFingerprint: ACCOUNT_MODE.fingerprint,
      quantity: "2",
      limitPrice: options.limitPrice ?? "100",
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
    finalGate: (signal, _input, _tx, context): LiveFinalGateResult => {
      void _input;
      void _tx;
      finalMode = context.mode;
      return {
        approved: true,
        signalId: signal.signalId,
        quantity: "2",
        notional: "200",
        reservedMargin: "40",
        reservedRisk: "2",
        validUntil: new Date(9_999_999_999_999),
      };
    },
  });
  gateway.positionRisk = async () => (await store.listOpenPositions()).map((position) => ({
    symbol: position.symbol,
    positionAmt: position.side === "SHORT" ? `-${position.quantity}` : position.quantity,
    entryPrice: position.entryPrice,
    markPrice: position.markPrice,
    liquidationPrice: position.liquidationPrice,
    leverage: position.leverage,
    marginType: "isolated",
    isolatedWallet: position.isolatedWallet === "0" ? "40" : position.isolatedWallet,
  }));
  return { store, gateway, created, claims, createIntent, claimIntent, pauseAutoTrade, assertCurrentAdmission, adapter,
    accountMode: ACCOUNT_MODE, finalMode: () => finalMode };
}

function useMomentumClaimDatabase(store: InMemoryLiveOrderStore, positionId: string) {
  const position = {
    id: positionId,
    symbol: "BTCUSDT",
    status: "OPEN",
    exitPending: false,
    exitReason: null as string | null,
    exitClaimId: null as string | null,
    exitClaimedAt: null as Date | null,
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const read = () => table === livePositions
            ? Promise.resolve([position])
            : table === liveOrders
              ? store.listOrders().then((orders) => orders.filter((order) => order.intentId === positionId
                && order.reduceOnly && order.type === "MARKET"))
              : Promise.reject(new Error("Unexpected claim table"));
          return {
            limit: (count: number) => table === livePositions
              ? { for: async () => [position] }
              : read().then((rows) => rows.slice(0, count)),
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => read().then(resolve, reject),
          };
        },
      }),
    }),
    update: (table: unknown) => {
      expect(table).toBe(livePositions);
      return {
        set: (values: Partial<typeof position>) => ({
          where: async () => { Object.assign(position, values); },
        }),
      };
    },
  };
  vi.mocked(getDb).mockReturnValue({
    transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
  } as never);
  return position;
}

describe("mainnet live execution adapter", () => {
  it("persists and claims the intent before IOC submission; acknowledgement alone creates no position", async () => {
    const h = setup();

    const result = await h.adapter.open(opportunity);
    expect(result).toMatchObject({ ok: true, positionId: h.created[0].id });
    expect(h.created).toHaveLength(1);
    expect(h.claims).toHaveLength(1);
    expect(h.createIntent.mock.calls[0]?.[1].requireAutoTrade).toBe(true);
    expect(h.gateway.placed[0]).toMatchObject({ type: "LIMIT", timeInForce: "IOC", quantity: "2" });
    expect(await h.store.getPosition(h.created[0].id)).toBeNull();
  });

  it("manual canary persists its admission class and submits while autoTrade is paused", async () => {
    const h = setup({ autoTrade: false });

    await expect(h.adapter.open(opportunity, undefined, { manualCanary: true })).resolves.toMatchObject({ ok: true });
    expect(h.createIntent.mock.calls[0]?.[1].requireAutoTrade).toBe(false);
    expect((await h.store.listOrders())[0]).toMatchObject({ manualCanary: true, status: "NEW" });
    expect(h.gateway.placed).toHaveLength(1);
  });

  it("cross-worker disarm during current admission invalidates both workers before transport", async () => {
    const h = setup();
    const clientOrderId = "cross-worker-entry";
    h.store.addOrder({
      id: "order-cross-worker",
      intentId: "intent-cross-worker",
      clientOrderId,
      exchangeOrderId: null,
      symbol: "BTCUSDT",
      side: "LONG",
      type: "LIMIT",
      status: "PENDING_SEND",
      price: "100",
      stopPrice: null,
      originalQuantity: "2",
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      reduceOnly: false,
      manualCanary: true,
      createdAt: 1,
    });

    const workerA = await h.store.admitOrder(clientOrderId, 7, async () => { h.store.pauseExecution(); });
    const workerB = await h.store.admitOrder(clientOrderId, 7, async () => undefined);

    expect(workerA.status).toBe("CANCEL");
    expect(workerB.status).toBe("CANCEL");
    expect(h.gateway.placed).toHaveLength(0);
  });

  it("revalidates current admission immediately before transport", async () => {
    const h = setup();
    h.assertCurrentAdmission.mockImplementation(async () => {
      if (h.assertCurrentAdmission.mock.calls.length === 2) h.store.pauseExecution();
    });

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: false });
    expect(h.gateway.placed).toHaveLength(0);
    expect((await h.store.listOrders())[0]?.status).toBe("CANCEL");
  });

  it("rejects transport when the current admission guard itself fails", async () => {
    const h = setup();
    h.assertCurrentAdmission.mockRejectedValue(new Error("preflight stale"));

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: false });
    expect(h.gateway.placed).toHaveLength(0);
    expect((await h.store.listOrders())[0]?.status).toBe("CANCEL");
  });

  it("passes the transactionally selected HIGH mode into the final gate", async () => {
    const h = setup({ mode: "HIGH" });

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: true });
    expect(h.finalMode()).toBe("HIGH");
  });

  it("a duplicate signal rejected by persistence never reaches the transport", async () => {
    const h = setup();
    h.createIntent.mockResolvedValueOnce({ ok: false, reason: "signalId 已存在" });

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: false });
    expect(h.claimIntent).not.toHaveBeenCalled();
    expect(h.gateway.placed).toHaveLength(0);
  });

  it("expired unfilled IOC returns non-success", async () => {
    const h = setup();
    h.gateway.placeOrder = async (request) => {
      h.gateway.placed.push(request);
      return {
        symbol: request.symbol,
        orderId: 500,
        clientOrderId: request.newClientOrderId ?? "entry",
        price: request.price ?? "0",
        origQty: request.quantity,
        executedQty: "0",
        status: "EXPIRED",
        side: request.side,
        type: request.type,
      };
    };

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: false });
  });

  it("recovers fills from every userTrades page before finishing UNKNOWN reconciliation", async () => {
    const h = setup();
    await h.store.insertOrder({
      id: "recovery-order",
      intentId: "recovery-intent",
      clientOrderId: "recovery-client",
      exchangeOrderId: "901",
      symbol: "BTCUSDT",
      side: "LONG",
      type: "LIMIT",
      status: "UNKNOWN",
      price: "100",
      stopPrice: null,
      originalQuantity: "1.5",
      executedQuantity: "0",
      averagePrice: "0",
      commission: "0",
      reduceOnly: false,
      createdAt: 1,
    });
    h.gateway.queryOrder = async () => ({
      symbol: "BTCUSDT",
      orderId: 901,
      clientOrderId: "recovery-client",
      price: "100",
      origQty: "1.5",
      executedQty: "1.5",
      status: "FILLED",
      side: "BUY",
      type: "LIMIT",
    });
    const fromIds: Array<number | undefined> = [];
    h.gateway.userTrades = async ({ fromId }) => {
      fromIds.push(fromId);
      const ids = fromId === undefined ? [1, 2] : fromId === 3 ? [3] : [];
      return ids.map((id) => ({
        symbol: "BTCUSDT",
        id,
        orderId: 901,
        side: "BUY",
        price: "100",
        qty: "0.5",
        realizedPnl: "0",
        commission: "0.01",
        commissionAsset: "USDT",
        time: id,
        buyer: true,
        maker: false,
      }));
    };

    const recovered = await h.adapter.recover("recovery-client", {
      id: "recovery-intent",
      symbol: "BTCUSDT",
      side: "LONG",
      stopPrice: "95",
      liquidationPrice: "50",
      leverage: "5",
      maintenanceBracket: 1,
      maintMarginRatio: "0.01",
      cumMaintenance: "0",
    });

    expect(recovered.executedQuantity).toBe("1.5");
    expect(recovered.commission).toBe("0.03");
    expect(fromIds.slice(0, 2)).toEqual([undefined, 3]);
  });

  it("rejects a prepared initial limit above the accepted opportunity cap", async () => {
    const h = setup({ limitPrice: "100.01" });

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("限价") });
    expect(h.createIntent).not.toHaveBeenCalled();
    expect(h.gateway.placed).toHaveLength(0);
  });

  it("enforces the persisted price cap and at most one replacement across restart", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const entryClientId = `${h.created[0].id}-entry`;
    h.gateway.queryOrder = async () => ({
      symbol: "BTCUSDT",
      orderId: 500,
      clientOrderId: entryClientId,
      price: "100",
      origQty: "2",
      executedQty: "0",
      status: "CANCELED",
      side: "BUY",
      type: "LIMIT",
    });

    await expect(h.adapter.replaceOrder(entryClientId, "100.01")).rejects.toThrow("限价");
    const restarted = new MainnetLiveExecutionAdapter({
      ...h,
      workerId: "worker-b",
      prepareIntent: () => { throw new Error("not used by replacement cap"); },
      finalGate: () => { throw new Error("not used by replacement cap"); },
    });
    await expect(restarted.replaceOrder(entryClientId, "100.01")).rejects.toThrow("限价");

    const replacement = await h.adapter.replaceOrder(entryClientId, "100");
    await expect(h.adapter.replaceOrder(replacement.clientOrderId, "100"))
      .rejects.toThrow("最多改单 1 次");
    await expect(restarted.replaceOrder(replacement.clientOrderId, "100"))
      .rejects.toThrow("最多改单 1 次");
  });

  it("disarm invalidates an entry replacement before its transport", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const entryClientId = `${h.created[0].id}-entry`;
    h.gateway.queryOrder = async () => ({
      symbol: "BTCUSDT", orderId: 500, clientOrderId: entryClientId, price: "100", origQty: "2",
      executedQty: "0", status: "CANCELED", side: "BUY", type: "LIMIT",
    });
    h.store.pauseExecution();

    const replacement = await h.adapter.replaceOrder(entryClientId, "100");
    expect(replacement.status).toBe("CANCEL");
    expect(h.gateway.placed).toHaveLength(1);
  });

  it("stale current preflight blocks an entry replacement before transport", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const entryClientId = `${h.created[0].id}-entry`;
    h.gateway.queryOrder = async () => ({
      symbol: "BTCUSDT", orderId: 500, clientOrderId: entryClientId, price: "100", origQty: "2",
      executedQty: "0", status: "CANCELED", side: "BUY", type: "LIMIT",
    });
    h.assertCurrentAdmission.mockRejectedValue(new Error("preflight stale"));

    const replacement = await h.adapter.replaceOrder(entryClientId, "100");
    expect(replacement.status).toBe("CANCEL");
    expect(h.gateway.placed).toHaveLength(1);
    expect(h.assertCurrentAdmission).toHaveBeenCalled();
  });

  it("cross-worker emergency CANCEL wins over submit admission and prevents transport", async () => {
    const h = setup();
    h.claimIntent.mockImplementationOnce(async (input) => {
      h.store.pauseExecution();
      return { ok: true as const, version: input.expectedVersion + 1 };
    });

    await expect(h.adapter.open(opportunity)).resolves.toMatchObject({ ok: false });
    expect(h.gateway.placed).toHaveLength(0);
    expect((await h.store.getOrder(`${h.created[0].id}-entry`))?.status).toBe("CANCEL");
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
    let settings: TradingSettings = {
      ...DEFAULT_SETTINGS,
      executionMode: "LIVE_MAINNET",
      autoTrade: true,
      momentumEnabled: true,
      strategyMode: "MOMENTUM",
    };
    const momentumStore = new InMemoryMomentumStateStore();
    const coordinator = createExecutionCoordinator({
      live: h.adapter,
      momentumStore,
      getSettings: async () => settings,
      getLiveControls: async () => ({ armed: true }),
      runLivePreflight: async () => ({ ready: true, reasons: [], checkedAt: new Date().toISOString() }),
      getLiveOperations: async () => ({
        orders: [], protectionOrders: [], unsettledIntents: [], reconciliationIssues: [],
        reconciliationSummary: { openIssues: 0, severeIssues: 0, lastDetectedAt: null },
      }),
      getOutstandingRisk: async () => ({ openPositions: 0, pendingIntents: 0, unfinishedOrders: 0 }),
      privateWs: { health: () => ({ configured: true, running: true, connected: true, lastMessageAt: Date.now(), reconnects: 0 }) },
      reconciliation: { health: () => ({ configured: true, running: true, lastRunAt: Date.now() }) },
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key", BINANCE_MAINNET_API_SECRET: "fake-secret" },
      market: { dataSource: "MAINNET" },
    });
    const now = Date.now();
    await coordinator.observeMomentumFrame({
      symbol: "BTCUSDT", event_time: now - 1, received_time: now, sequence: 1, generation: 1,
      quality: "GOOD", config_hash: "a".repeat(64), mark_price: 100, microprice: 100,
      spread_bps: 1, depth_imbalance: 0.2, aggressive_buy_volume: 2, aggressive_sell_volume: 1,
      short_return: 0.001, burst_z: 2, realized_volatility: 0.01,
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
    expect(await coordinator.positions()).toMatchObject([{
      signalId: opportunity.signalId,
      strategyType: "MOMENTUM",
      breakoutPrice: 100,
      exitPending: false,
    }]);
    settings = { ...settings, autoTrade: false };

    await expect(coordinator.open({ ...opportunity, signalId: "signal-2" })).resolves.toMatchObject({ ok: false });
    const beforeClose = h.gateway.placed.length;
    const result = await coordinator.close(h.created[0].id);
    expect(result.unsettled).toBe(true);
    expect(h.gateway.placed.length).toBe(beforeClose + 1);
    expect(h.gateway.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true, side: "SELL" });
  });

  it("crash after close insertion resumes PENDING_SEND once and suppresses later takeover", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const positionId = h.created[0].id;
    await h.adapter.handleFill(`${positionId}-entry`, {
      exchangeTradeId: "crash-recovery-fill",
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
    const claimPosition = useMomentumClaimDatabase(h.store, positionId);
    const frames = new InMemoryMomentumStateStore();
    const claims = new DrizzleMomentumStateStore();
    const momentumStore = {
      saveFrame: frames.saveFrame.bind(frames),
      latestFrame: frames.latestFrame.bind(frames),
      claimExit: claims.claimExit.bind(claims),
      markExitSubmitted: claims.markExitSubmitted.bind(claims),
      releaseExit: claims.releaseExit.bind(claims),
    };
    let now = 1_800_000_001_000;
    const settings: TradingSettings = {
      ...DEFAULT_SETTINGS,
      executionMode: "LIVE_MAINNET",
      autoTrade: true,
      momentumEnabled: true,
      strategyMode: "MOMENTUM",
    };
    const coordinatorFor = (adapter: MainnetLiveExecutionAdapter) => createExecutionCoordinator({
      live: adapter,
      getSettings: async () => settings,
      momentumStore,
      now: () => now,
    });
    const insertOrder = h.store.insertOrder.bind(h.store);
    const getOrder = h.store.getOrder.bind(h.store);
    let crashed = false;
    h.store.insertOrder = async (order) => {
      await insertOrder(order);
      if (order.clientOrderId === `close-${positionId}`) {
        crashed = true;
        throw new Error("crash after close insertion");
      }
    };
    h.store.getOrder = async (clientOrderId) => {
      if (crashed && clientOrderId === `close-${positionId}`) throw new Error("crash after close insertion");
      return getOrder(clientOrderId);
    };

    await expect(coordinatorFor(h.adapter).receiveMomentumFrame(reversalFrame(now - 10, 1)))
      .rejects.toThrow("crash after close insertion");
    h.store.insertOrder = insertOrder;
    h.store.getOrder = getOrder;
    expect(await h.store.getOrder(`close-${positionId}`)).toMatchObject({ status: "PENDING_SEND" });
    expect(claimPosition.exitPending).toBe(true);
    expect(h.gateway.placed.filter((request) => request.type === "MARKET")).toHaveLength(0);

    let markSubmitted!: () => void;
    let releaseClose!: () => void;
    const submitted = new Promise<void>((resolve) => { markSubmitted = resolve; });
    const closeRelease = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.gateway.placeOrder = async (request) => {
      h.gateway.placed.push(request);
      markSubmitted();
      await closeRelease;
      return {
        symbol: request.symbol,
        orderId: 900,
        clientOrderId: request.newClientOrderId ?? "close",
        price: "0",
        origQty: request.quantity,
        executedQty: "0",
        status: "NEW",
        side: request.side,
        type: request.type,
        reduceOnly: request.reduceOnly,
      };
    };
    now += 5_001;
    const resumed = coordinatorFor(h.adapter).receiveMomentumFrame(reversalFrame(now - 10, 2));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.gateway.placed.filter((request) => request.type === "MARKET")).toHaveLength(1);
    await submitted;
    expect(await h.store.getOrder(`close-${positionId}`)).toMatchObject({ status: "SUBMITTING" });
    const resumedClaimId = claimPosition.exitClaimId;

    now += 5_001;
    await coordinatorFor(h.adapter).receiveMomentumFrame(reversalFrame(now - 10, 3));
    expect(claimPosition.exitClaimId).toBe(resumedClaimId);
    expect(h.gateway.placed.filter((request) => request.type === "MARKET")).toHaveLength(1);
    expect((await h.store.listOrders()).filter((order) => order.type === "MARKET" && order.reduceOnly)).toHaveLength(1);

    releaseClose();
    await resumed;
    now += 5_001;
    await coordinatorFor(h.adapter).receiveMomentumFrame(reversalFrame(now - 10, 4));
    expect(h.gateway.placed.filter((request) => request.type === "MARKET")).toHaveLength(1);
    expect((await h.store.listOrders()).filter((order) => order.type === "MARKET" && order.reduceOnly)).toHaveLength(1);
  });

  it("lease takeover during an in-flight close reuses one exchange order", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const positionId = h.created[0].id;
    await h.adapter.handleFill(`${positionId}-entry`, {
      exchangeTradeId: "takeover-fill",
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
    const secondAdapter = new MainnetLiveExecutionAdapter({
      ...h,
      workerId: "worker-b",
      prepareIntent: () => { throw new Error("not used by close takeover"); },
      finalGate: () => { throw new Error("not used by close takeover"); },
    });
    const momentumStore = new InMemoryMomentumStateStore();
    let now = 1_800_000_001_000;
    const settings: TradingSettings = {
      ...DEFAULT_SETTINGS,
      executionMode: "LIVE_MAINNET",
      autoTrade: true,
      momentumEnabled: true,
      strategyMode: "MOMENTUM",
    };
    const coordinatorFor = (adapter: MainnetLiveExecutionAdapter) => createExecutionCoordinator({
      live: adapter,
      getSettings: async () => settings,
      momentumStore,
      now: () => now,
    });
    const first = coordinatorFor(h.adapter);
    const second = coordinatorFor(secondAdapter);
    let markCloseStarted!: () => void;
    let releaseClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => { markCloseStarted = resolve; });
    const closeRelease = new Promise<void>((resolve) => { releaseClose = resolve; });
    h.gateway.placeOrder = async (request) => {
      h.gateway.placed.push(request);
      expect(request.type).toBe("MARKET");
      markCloseStarted();
      await closeRelease;
      return {
        symbol: request.symbol,
        orderId: 900,
        clientOrderId: request.newClientOrderId ?? "close",
        price: "0",
        origQty: request.quantity,
        executedQty: "0",
        status: "NEW",
        side: request.side,
        type: request.type,
        reduceOnly: request.reduceOnly,
      };
    };
    const claim = momentumStore.claimExit.bind(momentumStore);
    let markTakeover!: () => void;
    const takeover = new Promise<void>((resolve) => { markTakeover = resolve; });
    momentumStore.claimExit = async (...args) => {
      const claimed = await claim(...args);
      if (claimed && args[4] > 1_800_000_001_000) markTakeover();
      return claimed;
    };

    const firstExit = first.receiveMomentumFrame(reversalFrame(now - 10, 1));
    await closeStarted;
    now += 5_001;
    const secondExit = second.receiveMomentumFrame(reversalFrame(now - 10, 2));
    await takeover;
    await new Promise((resolve) => setImmediate(resolve));
    releaseClose();
    await Promise.all([firstExit, secondExit]);

    expect(h.gateway.placed.filter((request) => request.type === "MARKET")).toHaveLength(1);
    expect((await h.store.listOrders()).filter((order) => order.type === "MARKET" && order.reduceOnly)).toHaveLength(1);
  });

  it("an exchange-cancelled close is not reported as a successful submission", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const positionId = h.created[0].id;
    await h.adapter.handleFill(`${positionId}-entry`, {
      exchangeTradeId: "cancel-close-fill", exchangeOrderId: "500", symbol: "BTCUSDT", side: "BUY",
      price: "100", quantity: "2", commission: "0.1", commissionAsset: "USDT", realizedPnl: "0", isMaker: false, executedAt: 10,
    }, seedFor(h.created[0]));
    const placeOrder = h.gateway.placeOrder;
    h.gateway.placeOrder = async (request) => {
      if (request.type !== "MARKET") return placeOrder(request);
      return {
        symbol: request.symbol, orderId: 999, clientOrderId: request.newClientOrderId ?? "close", price: "0",
        origQty: request.quantity, executedQty: "0", status: "CANCELED", side: request.side, type: request.type, reduceOnly: true,
      };
    };

    await expect(h.adapter.close(positionId, "衰竭平仓")).resolves.toMatchObject({ ok: false, unsettled: true, alreadyClosed: false });
  });

  it("cancelled unfilled LIVE close can claim and submit one controlled retry", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const positionId = h.created[0].id;
    await h.adapter.handleFill(`${positionId}-entry`, {
      exchangeTradeId: "cancel-close-retry-fill",
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
    useMomentumClaimDatabase(h.store, positionId);
    const claims = new DrizzleMomentumStateStore();
    const now = 1_800_000_001_000;
    expect(await claims.claimExit("LIVE_MAINNET", positionId, "衰竭平仓", "claim-first", now, 5_000)).toBe(true);

    await h.adapter.close(positionId, "衰竭平仓");
    await h.store.transitionOrder(`close-${positionId}`, ["NEW"], { status: "CANCEL" });
    expect(await claims.claimExit("LIVE_MAINNET", positionId, "衰竭平仓", "claim-retry", now + 5_001, 5_000)).toBe(true);
    const retry = await h.adapter.close(positionId, "衰竭平仓");

    expect(retry).toMatchObject({ ok: true, unsettled: true });
    expect(h.gateway.placed.filter((request) => request.type === "MARKET" && request.reduceOnly)).toHaveLength(2);
    expect((await h.store.listOrders()).filter((order) => order.type === "MARKET" && order.reduceOnly)).toHaveLength(2);
  });

  it("coordinator recovers a cancelled exhaustion exit even when signed valuation is unavailable", async () => {
    const h = setup();
    await h.adapter.open(opportunity);
    const positionId = h.created[0].id;
    await h.adapter.handleFill(`${positionId}-entry`, {
      exchangeTradeId: "exhaustion-recovery-fill", exchangeOrderId: "500", symbol: "BTCUSDT", side: "BUY",
      price: "100", quantity: "2", commission: "0.1", commissionAsset: "USDT", realizedPnl: "0", isMaker: false, executedAt: 10,
    }, seedFor(h.created[0]));
    const claimPosition = useMomentumClaimDatabase(h.store, positionId);
    await h.adapter.close(positionId, "动能衰竭退出");
    await h.store.transitionOrder(`close-${positionId}`, ["NEW"], { status: "CANCEL" });
    await h.store.updatePosition(positionId, { exitPending: true });
    claimPosition.exitPending = true;
    claimPosition.exitClaimId = "expired-exhaustion-claim";
    claimPosition.exitClaimedAt = new Date(1_800_000_000_000);
    h.gateway.positionRisk = async () => { throw new Error("signed valuation offline"); };
    const claims = new DrizzleMomentumStateStore();
    const coordinator = createExecutionCoordinator({
      live: h.adapter,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" }),
      momentumStore: claims,
      now: () => 1_800_000_010_000,
      market: { dataSource: "MAINNET", sourceGeneration: 0, getCandles: async () => [] },
      evaluateExhaustion: () => ({ side: "LONG", score: 0, resonanceCount: 0, resonant: false, protection: "NONE", structureBreak: false, timeframes: [], reasons: [] }),
      recordEvent: async () => undefined,
    });

    await coordinator.manageMomentumProtection();

    expect(h.gateway.placed.filter((request) => request.type === "MARKET" && request.reduceOnly)).toHaveLength(2);
    expect(await h.store.getOrder(`close-${positionId}-retry-1`)).toMatchObject({ status: "NEW" });
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
      assertCurrentAdmission: async () => undefined,
      prepareIntent: () => { throw new Error("not used"); },
      finalGate: () => { throw new Error("not used"); },
    });

    await adapter.emergency();
    expect(updates.find((update) => update.table === tradingSettings)?.values).toEqual({ autoTrade: false });
    expect(updates.some((update) => update.table === liveControls)).toBe(true);
  });
});
