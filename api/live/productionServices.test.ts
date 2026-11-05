import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Opportunity } from "@contracts/trading";
import { liveControls, liveIntents, livePositions, tradingSettings, volatilityStates } from "@db/schema";
import type { BinanceOpenOrder, BinanceSignedClient, PlaceOrderRequest } from "./binanceSigned";
import type { LiveDatabase } from "./livePersistence";
import { InMemoryLiveOrderStore } from "./orderStateMachine";
import { InMemoryReconciliationStore } from "./reconciliation";
import { InMemoryAccountingStore } from "./accounting";
import { createBinanceProductionLiveServices } from "./productionServices";
import { estimateFlatLiquidationPrice } from "./liveRisk";
import { createProductionLiveRuntime } from "./productionRuntime";
import type { LiveFill, LiveOrder, LivePositionSeed } from "./orderStateMachine";
import type { UserDataSocket } from "./userDataStream";
import type { MainnetLiveExecutionAdapter } from "./liveExecution";

const ACCOUNT_MODE = { dualSide: false, multiAssets: false, fingerprint: "0".repeat(64) } as const;

function finalGateDatabase(
  settings: Partial<typeof DEFAULT_SETTINGS> = {},
  existing: { positions?: Record<string, unknown>[]; intents?: Record<string, unknown>[] } = {},
) {
  const intentRows: Record<string, unknown>[] = [];
  const readRows = (table: unknown, selection?: Record<string, unknown>): unknown[] => table === tradingSettings
    ? [{ ...DEFAULT_SETTINGS, ...settings, executionMode: "LIVE_MAINNET", autoTrade: true }]
    : table === liveControls ? [{ armed: true, generation: 0 }]
      : table === volatilityStates ? [{ mode: "NORMAL" }]
        : table === livePositions ? existing.positions ?? []
          : table === liveIntents && selection?.margin === liveIntents.reservedMargin
            ? intentRows.map((row) => ({ margin: row.reservedMargin, risk: row.reservedRisk }))
            : table === liveIntents && selection?.symbol === liveIntents.symbol
              && selection.id === undefined ? intentRows
              : table === liveIntents ? [...existing.intents ?? [], ...intentRows] : [];
  const queryFor = (rows: unknown[]) => Object.assign(Promise.resolve(rows), {
    for: async () => rows,
    limit: () => Object.assign(Promise.resolve(rows), { for: async () => rows }),
  });
  const tx = {
    select: (selection?: Record<string, unknown>) => ({
      from: (table: unknown) => Object.assign(queryFor(readRows(table, selection)), {
        where: () => queryFor(readRows(table, selection)),
      }),
    }),
    execute: async () => [[{ db_now_ms: Date.now() }]],
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === liveIntents) intentRows.push(values);
      },
    }),
  };
  const db = {
    transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx),
    update: () => ({ set: () => ({ where: async () => [{ affectedRows: 1 }] }) }),
  } as unknown as LiveDatabase;
  return {
    db,
    inserted: () => intentRows.at(-1),
    insertedCount: () => intentRows.length,
    clearIntents: () => { intentRows.length = 0; },
  };
}

class FakeSocket implements UserDataSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data }); }
}

function fakeClient(now: () => number) {
  const placeOrder = vi.fn(async (request: PlaceOrderRequest): Promise<BinanceOpenOrder> => {
    void request;
    throw new Error("no orders in composition test");
  });
  const client = {
    positionSide: async () => ({ dualSidePosition: false }),
    multiAssetsMargin: async () => ({ multiAssetsMargin: false }),
    positionRisk: async () => [{
      symbol: "BTCUSDT", positionAmt: "0", entryPrice: "0", markPrice: "100",
      liquidationPrice: "40", leverage: "2", marginType: "isolated", isolatedWallet: "0",
    }],
    openOrders: async () => [],
    leverageBracket: async () => [{ symbol: "BTCUSDT", brackets: [{
      bracket: 1, initialLeverage: 10, notionalCap: "50000", notionalFloor: "0",
      maintMarginRatio: "0.01", cum: "0",
    }] }],
    exchangeInfo: async () => ({ symbols: [{
      symbol: "BTCUSDT", pair: "BTCUSDT", contractType: "PERPETUAL", status: "TRADING",
      baseAsset: "BTC", quoteAsset: "USDT", marginAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.01" },
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    }] }),
    account: async () => ({ assets: [{ asset: "USDT", walletBalance: "1000", availableBalance: "1000", crossWalletBalance: "1000" }] }),
    collateralRate: async () => { throw new Error("collateralRate not configured in fake"); },
    premiumIndex: async () => { throw new Error("premiumIndex not configured in fake"); },
    income: async () => [],
    userTrades: async () => [],
    createListenKey: async () => ({ listenKey: "fake-listen-key" }),
    keepAliveListenKey: async () => ({}),
    closeListenKey: async () => ({}),
    syncServerTime: async () => undefined,
    queryOrder: async () => null,
    cancelOrder: async () => ({}),
    placeOrder,
  };
  return { client: client as unknown as BinanceSignedClient, placeOrder, now };
}

describe("production service composition with fake exchange", () => {
  it("starts reconciliation/private WS, accepts an idle healthy connection, and stops cleanly", async () => {
    let now = 1_800_000_000_000;
    const socket = new FakeSocket();
    const { client, placeOrder } = fakeClient(() => now);
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true",
        BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret",
        BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: {} as LiveDatabase,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "FIXED", fixedLeverage: 2 }),
      client,
      orderStore: new InMemoryLiveOrderStore(),
      reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      socketFactory: () => socket,
      now: () => now,
      reconciliationIntervalMs: 60_000,
      accountMode: ACCOUNT_MODE,
    });

    await services.start();
    expect(services.reconciliation.health()).toMatchObject({ configured: true, running: true, lastRunAt: now });
    expect((await services.preflight()).ready).toBe(true);

    now += 1;
    socket.emit(JSON.stringify({ e: "ACCOUNT_UPDATE", E: now, a: { B: [{ a: "USDT" }] } }));
    await vi.waitFor(() => expect(services.privateWs.health().lastMessageAt).toBe(now));
    await expect(services.preflight()).resolves.toMatchObject({ ready: true, reasons: [] });

    await services.stop();
    expect(socket.closed).toBe(true);
    expect(services.reconciliation.health().running).toBe(false);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("keeps an idle but connected private WS eligible while heartbeat and REST reconciliation stay healthy", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_800_000_000_000;
      const socket = new FakeSocket();
      const { client } = fakeClient(() => now);
      const services = createBinanceProductionLiveServices({
        env: {
          LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
          BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
        },
        db: {} as LiveDatabase,
        getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "FIXED", fixedLeverage: 2 }),
        client,
        orderStore: new InMemoryLiveOrderStore(), reconciliationStore: new InMemoryReconciliationStore(),
        accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) }, socketFactory: () => socket,
        now: () => now, reconciliationIntervalMs: 5_000, accountMode: ACCOUNT_MODE,
      });
      await services.start();

      now += 10_001;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(services.privateWs.health().lastMessageAt).toBeNull();
      await expect(services.preflight()).resolves.toMatchObject({ ready: true });
      await services.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes exits with entries frozen while unresolved reconciliation retries", async () => {
    const now = () => 1_800_000_000_000;
    const socket = new FakeSocket();
    const { client, placeOrder } = fakeClient(now);
    vi.spyOn(client, "openOrders").mockResolvedValue([{
      symbol: "BTCUSDT", orderId: 99, clientOrderId: "unknown-manual", price: "100",
      origQty: "1", executedQty: "0", status: "NEW", side: "BUY", type: "LIMIT",
    }]);
    placeOrder.mockImplementation(async (request) => ({
      symbol: request.symbol, orderId: 100, clientOrderId: request.newClientOrderId ?? "fake-close",
      price: request.price ?? "0", origQty: request.quantity, executedQty: "0",
      status: "NEW", side: request.side, type: request.type, reduceOnly: request.reduceOnly,
    }));
    const orders = new InMemoryLiveOrderStore({ emergencyGeneration: 0, autoTrade: true });
    const seed: LivePositionSeed = {
      id: "intent-open", symbol: "BTCUSDT", side: "LONG", positionSide: "LONG", entrySemantics: "ENTRY",
      accountModeFingerprint: ACCOUNT_MODE.fingerprint, stopPrice: "99",
      liquidationPrice: "40", leverage: "2", maintenanceBracket: 1,
      maintMarginRatio: "0.01", cumMaintenance: "0",
    };
    const order: LiveOrder = {
      id: "order-row", intentId: seed.id, clientOrderId: "entry-open", exchangeOrderId: "1",
      symbol: seed.symbol, side: seed.side, positionSide: seed.positionSide, entrySemantics: "ENTRY",
      accountModeFingerprint: seed.accountModeFingerprint, type: "LIMIT", status: "NEW", price: "100",
      stopPrice: null, originalQuantity: "1", executedQuantity: "0", averagePrice: "0",
      commission: "0", reduceOnly: false, createdAt: now(),
    };
    await orders.insertOrder(order);
    const fill: LiveFill = {
      exchangeTradeId: "trade-open", exchangeOrderId: "1", symbol: seed.symbol,
      side: "BUY", price: "100", quantity: "1", commission: "0", commissionAsset: "USDT",
      realizedPnl: "0", isMaker: false, executedAt: now(),
    };
    await orders.applyFill(order.id, fill, seed);
    const pauseAutoTrade = vi.fn(async () => undefined);
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: {} as LiveDatabase,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "FIXED", fixedLeverage: 2 }),
      client, orderStore: orders, reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) }, socketFactory: () => socket,
      now, reconciliationIntervalMs: 60_000, pauseAutoTrade, accountMode: ACCOUNT_MODE,
    });
    const runtime = createProductionLiveRuntime({
      env: { LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake", BINANCE_MAINNET_API_SECRET: "fake" },
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" }),
      getLiveControls: async () => ({ armed: true }), hasOutstandingLiveRisk: async () => true,
      createServices: () => services,
    });

    try {
      const adapter = await Promise.race([
        runtime.getLiveAdapter(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("adapter publication hung")), 250)),
      ]);
      expect(adapter).not.toBeNull();
      expect((await services.preflight()).ready).toBe(false);
      await expect(adapter!.close(seed.id, "fake unresolved recovery exit")).resolves.toMatchObject({ ok: true, unsettled: true });
      await expect(adapter!.emergency()).resolves.toMatchObject({ paused: true });
      expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ reduceOnly: true }));
      expect(pauseAutoTrade).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });

  it("discovers the production account mode before dual-side exit submission", async () => {
    const now = () => 1_800_000_000_000;
    const { client, placeOrder } = fakeClient(now);
    vi.spyOn(client, "positionSide").mockResolvedValue({ dualSidePosition: true });
    vi.spyOn(client, "positionRisk").mockResolvedValue([{
      symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "1", entryPrice: "100", markPrice: "100",
      liquidationPrice: "40", leverage: "2", marginType: "isolated", isolatedWallet: "50",
    }]);
    placeOrder.mockImplementation(async (request) => ({
      symbol: request.symbol, orderId: 100, clientOrderId: request.newClientOrderId ?? "fake-close",
      price: request.price ?? "0", origQty: request.quantity, executedQty: "0", positionSide: request.positionSide,
      status: "NEW", side: request.side, type: request.type, reduceOnly: request.reduceOnly,
    }));
    const { createHash } = await import("node:crypto");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ dualSide: true, multiAssets: false })).digest("hex");
    const orders = new InMemoryLiveOrderStore();
    const seed: LivePositionSeed = {
      id: "dual-intent", symbol: "BTCUSDT", side: "LONG", positionSide: "LONG", entrySemantics: "ENTRY",
      accountModeFingerprint: fingerprint, stopPrice: "99", liquidationPrice: "40", leverage: "2",
      maintenanceBracket: 1, maintMarginRatio: "0.01", cumMaintenance: "0",
    };
    const order: LiveOrder = {
      id: "dual-entry-row", intentId: seed.id, clientOrderId: "dual-entry", exchangeOrderId: "1",
      symbol: seed.symbol, side: seed.side, positionSide: seed.positionSide, entrySemantics: "ENTRY",
      accountModeFingerprint: fingerprint, type: "LIMIT", status: "FILLED", price: "100", stopPrice: null,
      originalQuantity: "1", executedQuantity: "0", averagePrice: "0", commission: "0", reduceOnly: false,
      createdAt: now(),
    };
    await orders.insertOrder(order);
    await orders.applyFill(order.id, {
      exchangeTradeId: "dual-entry-fill", exchangeOrderId: "1", symbol: seed.symbol, side: "BUY",
      price: "100", quantity: "1", commission: "0", commissionAsset: "USDT", realizedPnl: "0",
      isMaker: false, executedAt: now(),
    }, seed);
    const { createBinanceProductionLiveServicesFromStore } = await import("./productionServices");
    const services = await createBinanceProductionLiveServicesFromStore({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: {} as LiveDatabase, client, orderStore: orders,
      reconciliationStore: new InMemoryReconciliationStore(), accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      now,
    });

    await expect(services.adapter.close(seed.id, "dual account-mode discovery")).resolves.toMatchObject({ ok: true });

    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      side: "SELL", positionSide: "LONG", quantity: "1", newClientOrderId: `close-${seed.id}`,
    }));
    expect(placeOrder.mock.calls[0]?.[0]).not.toHaveProperty("reduceOnly");
    expect(await orders.getOrder(`close-${seed.id}`)).toMatchObject({ accountModeFingerprint: fingerprint });
  });

  it("binds same-symbol LONG and SHORT portfolio legs to their own persisted stops", async () => {
    const now = () => 1_800_000_000_000;
    const socket = new FakeSocket();
    const { client, placeOrder } = fakeClient(now);
    const orderStore = new InMemoryLiveOrderStore();
    const accountMode = { dualSide: true, multiAssets: false, fingerprint: "0".repeat(64) };
    const positionRows: Record<string, unknown>[] = [];
    const intentRows: Record<string, unknown>[] = [];
    const flatTarget = (positionSide: "LONG" | "SHORT") => ({
      symbol: "ETHUSDT", positionSide, positionAmt: "0", entryPrice: "0", markPrice: "100",
      liquidationPrice: "0", leverage: "2", marginType: "isolated", isolatedWallet: "0",
      positionInitialMargin: "0",
    });
    let remotePositions = [flatTarget("LONG"), flatTarget("SHORT")];
    vi.spyOn(client, "positionSide").mockResolvedValue({ dualSidePosition: true });
    vi.spyOn(client, "positionRisk").mockImplementation(async () => remotePositions);
    vi.spyOn(client, "leverageBracket").mockImplementation(async (symbol) => [{
      symbol: symbol ?? "ETHUSDT",
      brackets: [{
        bracket: 1, initialLeverage: 10, notionalCap: "50000", notionalFloor: "0",
        maintMarginRatio: "0.01", cum: "0",
      }],
    }]);
    vi.spyOn(client, "exchangeInfo").mockImplementation(async (symbol) => ({
      symbols: [{
        symbol: symbol ?? "ETHUSDT", pair: symbol ?? "ETHUSDT", contractType: "PERPETUAL", status: "TRADING",
        baseAsset: "ETH", quoteAsset: "USDT", marginAsset: "USDT",
        filters: [
          { filterType: "PRICE_FILTER", tickSize: "0.01" },
          { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
          { filterType: "MIN_NOTIONAL", notional: "5" },
        ],
      }],
    }));
    vi.spyOn(client, "account").mockResolvedValue({
      assets: [{ asset: "USDT", walletBalance: "1000", availableBalance: "1000" }],
      totalWalletBalance: "1000", totalMarginBalance: "1000", availableBalance: "1000",
      totalPositionInitialMargin: "20",
    });
    placeOrder.mockImplementation(async (request) => ({
      symbol: request.symbol, orderId: 200, clientOrderId: request.newClientOrderId ?? "dual-portfolio-entry",
      price: request.price ?? "0", origQty: request.quantity, executedQty: "0", status: "NEW",
      side: request.side, positionSide: request.positionSide, type: request.type,
    }));
    const settings = {
      ...DEFAULT_SETTINGS,
      executionMode: "LIVE_MAINNET" as const,
      leverageMode: "FIXED" as const,
      fixedLeverage: 2,
      riskPerTradePct: 0.01,
      portfolioStopRiskPct: 0.1,
    };
    const store = finalGateDatabase(settings, { positions: positionRows, intents: intentRows });
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "ETHUSDT",
      },
      db: store.db,
      getSettings: async () => settings,
      client,
      orderStore,
      reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      market: {
        getCandles: async (symbol) => Array.from({ length: 62 }, (_, index) => ({
          time: now() - (62 - index) * 900_000,
          closeTime: now() - (61 - index) * 900_000,
          open: 100, high: 110, low: 90, volume: 1000,
          close: 100 + index * (symbol === "ETHUSDT" ? 0.01 : 0.02),
        })),
      },
      socketFactory: () => socket,
      now,
      reconciliationIntervalMs: 60_000,
      accountMode,
    });
    const signal: Opportunity = {
      id: "dual-portfolio-opportunity", signalId: "dual-portfolio-signal", strategyType: "SWING",
      symbol: "ETHUSDT", side: "LONG", status: "READY", score: 1, regime: "NORMAL",
      entry: 100, stop: 99.5, target: 101.1, stopDistancePct: 0.5, rewardRisk: 2.2,
      leverage: 2, marginPct: 2, riskPct: 0.01, reasons: [], signalCloseTime: now(), signalTime: now(),
      expiryTime: now() + 60_000, triggerPrice: 100, limitPrice: 100, stateVersion: 1,
      sourceGeneration: 1, detectorVersion: "test", configVersion: "test", createdAt: new Date(now()).toISOString(),
    };

    try {
      await services.start();
      for (const leg of ["LONG", "SHORT"] as const) {
        const id = `btc-${leg.toLowerCase()}-intent`;
        const stopPrice = leg === "LONG" ? "101" : "99";
        const seed: LivePositionSeed = {
          id, symbol: "BTCUSDT", side: leg, positionSide: leg, entrySemantics: "ENTRY",
          effectiveLeverage: 2, marginType: "ISOLATED", liquidationPriceSource: "EXCHANGE",
          accountModeFingerprint: accountMode.fingerprint, compatibilityFrozen: false,
          stopPrice, liquidationPrice: leg === "LONG" ? "50" : "150", leverage: "2",
          maintenanceBracket: 1, maintMarginRatio: "0.01", cumMaintenance: "0",
        };
        const order: LiveOrder = {
          id: `${id}-order`, intentId: id, clientOrderId: `${id}-entry`, exchangeOrderId: id,
          symbol: seed.symbol, side: leg, positionSide: leg, entrySemantics: "ENTRY",
          effectiveLeverage: 2, marginType: "ISOLATED", liquidationPriceSource: "EXCHANGE",
          accountModeFingerprint: accountMode.fingerprint, compatibilityFrozen: false,
          type: "LIMIT", status: "NEW", price: "100", stopPrice: null,
          originalQuantity: "1", executedQuantity: "0", averagePrice: "0", commission: "0",
          reduceOnly: false, createdAt: now(),
        };
        await orderStore.insertOrder(order);
        await orderStore.applyFill(order.id, {
          exchangeTradeId: `${id}-trade`, exchangeOrderId: id, symbol: seed.symbol,
          side: leg === "LONG" ? "BUY" : "SELL", positionSide: leg,
          price: "100", quantity: "1", commission: "0", commissionAsset: "USDT",
          realizedPnl: "0", isMaker: false, executedAt: now(),
        }, seed);
        positionRows.push({ id, symbol: seed.symbol, positionSide: leg });
        intentRows.push({ id, stopPrice, status: "FILLED" });
      }
      remotePositions = [
        flatTarget("LONG"),
        flatTarget("SHORT"),
        {
          symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "1", entryPrice: "100", markPrice: "100",
          liquidationPrice: "50", leverage: "2", marginType: "isolated", isolatedWallet: "10",
          positionInitialMargin: "10",
        },
        {
          symbol: "BTCUSDT", positionSide: "SHORT", positionAmt: "-1", entryPrice: "100", markPrice: "100",
          liquidationPrice: "150", leverage: "2", marginType: "isolated", isolatedWallet: "10",
          positionInitialMargin: "10",
        },
      ];

      await expect(services.preflight()).resolves.toMatchObject({ ready: true, reasons: [] });
      const opened = await services.adapter.open(signal);

      expect(opened.ok, opened.reason).toBe(true);
      expect(store.inserted()).toMatchObject({ symbol: "ETHUSDT", effectiveLeverage: 2 });
      expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: "ETHUSDT", positionSide: "LONG" }));
    } finally {
      await services.stop();
    }
  });

  it.each([
    { field: "mode", check: 1 },
    { field: "mode", check: 2 },
    { field: "leverage", check: 1 },
    { field: "leverage", check: 2 },
    { field: "bracket", check: 1 },
    { field: "bracket", check: 2 },
  ] as const)("cancels transport when $field changes at admission check $check", async ({ field, check }) => {
    const now = () => 1_800_000_000_000;
    const socket = new FakeSocket();
    const { client, placeOrder } = fakeClient(now);
    placeOrder.mockImplementation(async (request) => ({
      symbol: request.symbol, orderId: 175, clientOrderId: request.newClientOrderId ?? "admission-entry",
      price: request.price ?? "0", origQty: request.quantity, executedQty: "0", status: "NEW",
      side: request.side, positionSide: request.positionSide, type: request.type, reduceOnly: request.reduceOnly,
    }));
    let admitting = false;
    let freshBracket = false;
    let reads = 0;
    vi.spyOn(client, "positionSide").mockImplementation(async () => {
      if (admitting && field === "mode") reads += 1;
      return { dualSidePosition: admitting && reads === check && field === "mode" };
    });
    vi.spyOn(client, "positionRisk").mockImplementation(async (symbol) => {
      if (admitting && symbol && field === "leverage") reads += 1;
      if (admitting && symbol && field === "bracket") freshBracket = true;
      return [{
        symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", entryPrice: "0", markPrice: "100",
        liquidationPrice: "0", leverage: admitting && reads === check && field === "leverage" ? "3" : "2",
        marginType: "isolated", isolatedWallet: "0", positionInitialMargin: "0",
      }];
    });
    vi.spyOn(client, "leverageBracket").mockImplementation(async () => {
      if (freshBracket) {
        freshBracket = false;
        reads += 1;
      }
      return [{
        symbol: "BTCUSDT",
        brackets: [{
          bracket: 1, initialLeverage: 10, notionalCap: "50000", notionalFloor: "0",
          maintMarginRatio: admitting && reads === check && field === "bracket" ? "0.02" : "0.01", cum: "0",
        }],
      }];
    });
    const orderStore = new InMemoryLiveOrderStore();
    const insertOrder = orderStore.insertOrder.bind(orderStore);
    orderStore.insertOrder = async (order) => {
      admitting = true;
      reads = 0;
      await insertOrder(order);
    };
    const settings = {
      ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" as const, leverageMode: "FIXED" as const,
      fixedLeverage: 2, riskPerTradePct: 0.01, portfolioStopRiskPct: 0.1,
    };
    const store = finalGateDatabase(settings);
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: store.db,
      getSettings: async () => settings,
      client,
      orderStore,
      reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      socketFactory: () => socket,
      now,
      accountMode: ACCOUNT_MODE,
    });
    const signal: Opportunity = {
      id: `admission-${field}-${check}`, signalId: `admission-${field}-${check}`, strategyType: "SWING",
      symbol: "BTCUSDT", side: "LONG", status: "READY", score: 1, regime: "NORMAL",
      entry: 100, stop: 99.5, target: 101.1, stopDistancePct: 0.5, rewardRisk: 2.2,
      leverage: 2, marginPct: 2, riskPct: 0.01, reasons: [], signalCloseTime: now(), signalTime: now(),
      expiryTime: now() + 60_000, triggerPrice: 100, limitPrice: 100, stateVersion: 1,
      sourceGeneration: 1, detectorVersion: "test", configVersion: "test", createdAt: new Date(now()).toISOString(),
    };

    try {
      await services.start();
      await expect(services.preflight()).resolves.toMatchObject({ ready: true });
      const opened = await services.adapter.open(signal);

      expect(opened.ok).toBe(false);
      expect(placeOrder).not.toHaveBeenCalled();
      expect(store.insertedCount()).toBe(1);
      const orders = await orderStore.listOrders();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ status: "CANCEL" });
    } finally {
      await services.stop();
    }
  });

  it("cancels an entry replacement when its fresh bracket differs from the persisted approval", async () => {
    const now = () => 1_800_000_000_000;
    const socket = new FakeSocket();
    const { client, placeOrder } = fakeClient(now);
    placeOrder.mockImplementation(async (request) => ({
      symbol: request.symbol, orderId: 180 + placeOrder.mock.calls.length,
      clientOrderId: request.newClientOrderId ?? "replacement-entry", price: request.price ?? "0",
      origQty: request.quantity, executedQty: "0", status: "NEW", side: request.side,
      positionSide: request.positionSide, type: request.type, reduceOnly: request.reduceOnly,
    }));
    vi.spyOn(client, "positionRisk").mockResolvedValue([{
      symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0", entryPrice: "0", markPrice: "100",
      liquidationPrice: "0", leverage: "2", marginType: "isolated", isolatedWallet: "0", positionInitialMargin: "0",
    }]);
    let maintMarginRatio = "0.01";
    vi.spyOn(client, "leverageBracket").mockImplementation(async () => [{
      symbol: "BTCUSDT",
      brackets: [{
        bracket: 1, initialLeverage: 10, notionalCap: "50000", notionalFloor: "0",
        maintMarginRatio, cum: "0",
      }],
    }]);
    const orderStore = new InMemoryLiveOrderStore();
    const settings = {
      ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET" as const, leverageMode: "FIXED" as const,
      fixedLeverage: 2, riskPerTradePct: 0.01, portfolioStopRiskPct: 0.1,
    };
    const store = finalGateDatabase(settings);
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: store.db,
      getSettings: async () => settings,
      client,
      orderStore,
      reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      socketFactory: () => socket,
      now,
      accountMode: ACCOUNT_MODE,
    });
    const signal: Opportunity = {
      id: "replacement-bracket-opportunity", signalId: "replacement-bracket-signal", strategyType: "SWING",
      symbol: "BTCUSDT", side: "LONG", status: "READY", score: 1, regime: "NORMAL",
      entry: 100, stop: 99.5, target: 101.1, stopDistancePct: 0.5, rewardRisk: 2.2,
      leverage: 2, marginPct: 2, riskPct: 0.01, reasons: [], signalCloseTime: now(), signalTime: now(),
      expiryTime: now() + 60_000, triggerPrice: 100, limitPrice: 100, stateVersion: 1,
      sourceGeneration: 1, detectorVersion: "test", configVersion: "test", createdAt: new Date(now()).toISOString(),
    };

    try {
      await services.start();
      await expect(services.preflight()).resolves.toMatchObject({ ready: true });
      await expect(services.adapter.open(signal)).resolves.toMatchObject({ ok: true });
      expect(placeOrder).toHaveBeenCalledTimes(1);
      const entryOrder = (await orderStore.listOrders())[0]!;
      vi.spyOn(client, "queryOrder").mockResolvedValue({
        symbol: "BTCUSDT", orderId: Number(entryOrder.exchangeOrderId), clientOrderId: entryOrder.clientOrderId,
        price: "100", origQty: entryOrder.originalQuantity, executedQty: "0", status: "CANCELED",
        side: "BUY", positionSide: "BOTH", type: "LIMIT",
      });
      maintMarginRatio = "0.02";

      const replacement = await (services.adapter as MainnetLiveExecutionAdapter)
        .replaceOrder(entryOrder.clientOrderId, "100");

      expect(replacement.status).toBe("CANCEL");
      expect(placeOrder).toHaveBeenCalledTimes(1);
    } finally {
      await services.stop();
    }
  });

  it("includes account mode in read-only preflight", async () => {
    const now = () => 1_800_000_000_000;
    const { client } = fakeClient(now);
    vi.spyOn(client, "positionSide").mockResolvedValue({ dualSidePosition: true });
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: finalGateDatabase().db,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "FIXED", fixedLeverage: 2 }),
      client,
      orderStore: new InMemoryLiveOrderStore(),
      reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      socketFactory: () => new FakeSocket(),
      now,
      accountMode: ACCOUNT_MODE,
    });

    await expect(services.preflight()).resolves.toMatchObject({ ready: false });
    expect((await services.preflight()).reasons.join(" ")).toMatch(/mode|模式/);
  });

  it("uses the same multi-asset totals and actual 150x leverage through finalGate persistence", async () => {
    const now = () => 1_800_000_000_000;
    const socket = new FakeSocket();
    const { client, placeOrder } = fakeClient(now);
    let changeAfterNextModeRead = false;
    vi.spyOn(client, "positionSide").mockImplementation(async () => {
      if (changeAfterNextModeRead) {
        changeAfterNextModeRead = false;
        return { dualSidePosition: false };
      }
      return { dualSidePosition: true };
    });
    vi.spyOn(client, "multiAssetsMargin").mockResolvedValue({ multiAssetsMargin: true });
    vi.spyOn(client, "positionRisk").mockResolvedValue([{
      symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "0", entryPrice: "0", markPrice: "100",
      liquidationPrice: "0", leverage: "150", marginType: "cross",
    }, {
      symbol: "BTCUSDT", positionSide: "SHORT", positionAmt: "0", entryPrice: "0", markPrice: "100",
      liquidationPrice: "0", leverage: "150", marginType: "cross",
    }]);
    let bracketResponse = [{
      symbol: "BTCUSDT",
      brackets: [{
        bracket: 1, initialLeverage: 150, notionalCap: "1458.7", notionalFloor: "0",
        maintMarginRatio: "0.005", cum: "0",
      }, {
        bracket: 2, initialLeverage: 150, notionalCap: "50000", notionalFloor: "1458.7",
        maintMarginRatio: "0.006", cum: "1.4587",
      }],
    }];
    let changeAfterNextBracketRead = false;
    vi.spyOn(client, "leverageBracket").mockImplementation(async () => {
      const current = bracketResponse;
      if (changeAfterNextBracketRead) {
        changeAfterNextBracketRead = false;
        bracketResponse = [{
          ...current[0],
          brackets: current[0].brackets.map((bracket, index) => index === 0
            ? { ...bracket, maintMarginRatio: "0.0055" } : bracket),
        }];
      }
      return current;
    });
    let account = {
      assets: [
        { asset: "USDT", walletBalance: "600", availableBalance: "500", crossWalletBalance: "600" },
        { asset: "BNB", walletBalance: "1", availableBalance: "1", crossWalletBalance: "1" },
      ],
      totalWalletBalance: "1000",
      totalMarginBalance: "1000",
      availableBalance: "900",
      totalPositionInitialMargin: "0",
      totalCrossWalletBalance: "1000",
      totalCrossUnPnl: "0",
    };
    let changeAfterNextAccountRead = false;
    vi.spyOn(client, "account").mockImplementation(async () => {
      const current = account;
      if (changeAfterNextAccountRead) {
        changeAfterNextAccountRead = false;
        account = { ...account, totalCrossWalletBalance: "999" };
      }
      return current;
    });
    placeOrder.mockImplementation(async (request) => ({
      symbol: request.symbol, orderId: 150, clientOrderId: request.newClientOrderId ?? "account-entry",
      price: request.price ?? "0", origQty: request.quantity, executedQty: "0", status: "NEW",
      side: request.side, positionSide: request.positionSide, type: request.type,
    }));
    const store = finalGateDatabase({ leverageMode: "ACCOUNT_CONFIGURED", fixedLeverage: 20 });
    let collateralHaircut = "1";
    let changeAfterNextCollateralRead = false;
    vi.spyOn(client, "collateralRate").mockImplementation(async () => {
      const current = collateralHaircut;
      if (changeAfterNextCollateralRead) {
        changeAfterNextCollateralRead = false;
        collateralHaircut = "0.5";
      }
      return [{ asset: "BNB", collateralRate: current, updateTime: now() - 1000 }];
    });
    vi.spyOn(client, "premiumIndex").mockImplementation(async (symbol) => ({ symbol, markPrice: "400" }));
    const services = createBinanceProductionLiveServices({
      env: {
        LIVE_TRADING_ENABLED: "true", BINANCE_MAINNET_API_KEY: "fake-key",
        BINANCE_MAINNET_API_SECRET: "fake-secret", BINANCE_MAINNET_ALLOWED_SYMBOLS: "BTCUSDT",
      },
      db: store.db,
      getSettings: async () => ({
        ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "ACCOUNT_CONFIGURED", fixedLeverage: 20,
      }),
      client,
      orderStore: new InMemoryLiveOrderStore(),
      reconciliationStore: new InMemoryReconciliationStore(),
      accountingStore: new InMemoryAccountingStore(),
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      socketFactory: () => socket,
      now,
      accountMode: { dualSide: true, multiAssets: true, fingerprint: ACCOUNT_MODE.fingerprint },
    });
    const signal: Opportunity = {
      id: "multi-asset-opportunity", signalId: "multi-asset-signal", strategyType: "SWING",
      symbol: "BTCUSDT", side: "LONG", status: "READY", score: 1, regime: "NORMAL",
      entry: 100, stop: 99.9, target: 100.22, stopDistancePct: 0.1, rewardRisk: 2.2,
      leverage: 150, marginPct: 2, riskPct: 0.35, reasons: [], signalCloseTime: now(), signalTime: now(),
      expiryTime: now() + 60_000, triggerPrice: 100, limitPrice: 100, stateVersion: 1,
      sourceGeneration: 1, detectorVersion: "test", configVersion: "test", createdAt: new Date(now()).toISOString(),
    };

    try {
      await services.start();
      await expect(services.preflight()).resolves.toMatchObject({ ready: true });
      await expect(services.adapter.account()).resolves.toMatchObject({ equity: 1000, cash: 1000, availableMargin: 900 });
      const opened = await services.adapter.open(signal);
      expect(opened.ok, opened.reason).toBe(true);
      expect(store.inserted()).toMatchObject({
        effectiveLeverage: 150,
        leverage: 150,
        marginType: "CROSS",
        maintenanceBracket: 2,
        maintMarginRatio: "0.006",
        cumMaintenance: "1.4587",
        reservedMargin: "9.724666666666666666666666666666",
        liquidationPriceSource: "PRETRADE_ESTIMATE",
        compatibilityFrozen: false,
      });
      expect(store.inserted()?.liquidationPrice).not.toBe(estimateFlatLiquidationPrice({
        side: "LONG", entryPrice: "100", leverage: 150, maintMarginRatio: "0.006",
      }));
      expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ positionSide: "LONG" }));

      const blocked = await services.adapter.open({
        ...signal,
        id: "cross-pending-opportunity",
        signalId: "cross-pending-signal",
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.reason).toMatch(/cross 持仓或相关待单/);
      expect(store.insertedCount()).toBe(1);
      expect(placeOrder).toHaveBeenCalledTimes(1);

      store.clearIntents();
      await expect(services.preflight()).resolves.toMatchObject({ ready: true });
      changeAfterNextAccountRead = true;
      const changed = await services.adapter.open({
        ...signal,
        id: "cross-changed-snapshot-opportunity",
        signalId: "cross-changed-snapshot-signal",
      });
      expect(changed.ok).toBe(false);
      expect(changed.reason).toMatch(/二次快照|snapshot/);
      expect(store.insertedCount()).toBe(0);
      expect(placeOrder).toHaveBeenCalledTimes(1);

      store.clearIntents();
      changeAfterNextBracketRead = true;
      const changedBracket = await services.adapter.open({
        ...signal,
        id: "cross-changed-bracket-opportunity",
        signalId: "cross-changed-bracket-signal",
      });
      expect(changedBracket.ok).toBe(false);
      expect(changedBracket.reason).toMatch(/bracket|档位/);
      expect(store.insertedCount()).toBe(0);
      expect(placeOrder).toHaveBeenCalledTimes(1);

      store.clearIntents();
      changeAfterNextCollateralRead = true;
      const changedCollateral = await services.adapter.open({
        ...signal,
        id: "cross-changed-collateral-opportunity",
        signalId: "cross-changed-collateral-signal",
      });
      expect(changedCollateral.ok).toBe(false);
      expect(changedCollateral.reason).toMatch(/collateral|折算/);
      expect(store.insertedCount()).toBe(0);
      expect(placeOrder).toHaveBeenCalledTimes(1);

      store.clearIntents();
      changeAfterNextModeRead = true;
      const changedMode = await services.adapter.open({
        ...signal,
        id: "cross-changed-mode-opportunity",
        signalId: "cross-changed-mode-signal",
      }).catch((error: unknown) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
      expect(changedMode.ok).toBe(false);
      expect(changedMode.reason).toMatch(/mode|positionSide|模式/);
      expect(store.insertedCount()).toBe(0);
      expect(placeOrder).toHaveBeenCalledTimes(1);

      store.clearIntents();
      await expect(services.preflight()).resolves.toMatchObject({ ready: true });
      bracketResponse = [{
        ...bracketResponse[0],
        brackets: bracketResponse[0].brackets.map((bracket) => bracket.bracket === 2
          ? { ...bracket, initialLeverage: 125 } : bracket),
      }];
      const overUpperBracketLeverage = await services.adapter.open({
        ...signal,
        id: "cross-seam-leverage-opportunity",
        signalId: "cross-seam-leverage-signal",
      });
      expect(overUpperBracketLeverage.ok).toBe(false);
      expect(overUpperBracketLeverage.reason).toMatch(/杠杆|leverage/);
      expect(store.insertedCount()).toBe(0);
      expect(placeOrder).toHaveBeenCalledTimes(1);
    } finally {
      await services.stop();
    }
  });
});
