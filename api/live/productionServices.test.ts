import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Opportunity } from "@contracts/trading";
import { liveControls, liveIntents, tradingSettings, volatilityStates } from "@db/schema";
import type { BinanceOpenOrder, BinanceSignedClient, PlaceOrderRequest } from "./binanceSigned";
import type { LiveDatabase } from "./livePersistence";
import { InMemoryLiveOrderStore } from "./orderStateMachine";
import { InMemoryReconciliationStore } from "./reconciliation";
import { InMemoryAccountingStore } from "./accounting";
import { createBinanceProductionLiveServices } from "./productionServices";
import { createProductionLiveRuntime } from "./productionRuntime";
import type { LiveFill, LiveOrder, LivePositionSeed } from "./orderStateMachine";
import type { UserDataSocket } from "./userDataStream";

const ACCOUNT_MODE = { dualSide: false, fingerprint: "0".repeat(64) } as const;

function finalGateDatabase(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const intentRows: Record<string, unknown>[] = [];
  const tx = {
    select: (selection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const rows: unknown[] = table === tradingSettings
            ? [{ ...DEFAULT_SETTINGS, ...settings, executionMode: "LIVE_MAINNET", autoTrade: true }]
            : table === liveControls ? [{ armed: true, generation: 0 }]
              : table === volatilityStates ? [{ mode: "NORMAL" }]
                : table === liveIntents && selection?.margin === liveIntents.reservedMargin
                  ? intentRows.map((row) => ({ margin: row.reservedMargin, risk: row.reservedRisk }))
                  : table === liveIntents ? intentRows : [];
          const query = Object.assign(Promise.resolve(rows), {
            for: async () => rows,
          });
          return Object.assign(query, {
            limit: () => Object.assign(Promise.resolve(rows), { for: async () => rows }),
          });
        },
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
  return { db, inserted: () => intentRows.at(-1), insertedCount: () => intentRows.length };
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
        now: () => now, reconciliationIntervalMs: 5_000,
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

  it("uses the same multi-asset totals and actual 150x leverage through finalGate persistence", async () => {
    const now = () => 1_800_000_000_000;
    const socket = new FakeSocket();
    const { client, placeOrder } = fakeClient(now);
    vi.spyOn(client, "positionSide").mockResolvedValue({ dualSidePosition: true });
    vi.spyOn(client, "multiAssetsMargin").mockResolvedValue({ multiAssetsMargin: true });
    vi.spyOn(client, "positionRisk").mockResolvedValue([{
      symbol: "BTCUSDT", positionSide: "LONG", positionAmt: "0", entryPrice: "0", markPrice: "100",
      liquidationPrice: "0", leverage: "150", marginType: "cross",
    }]);
    vi.spyOn(client, "leverageBracket").mockResolvedValue([{
      symbol: "BTCUSDT",
      brackets: [{
        bracket: 1, initialLeverage: 150, notionalCap: "50000", notionalFloor: "0",
        maintMarginRatio: "0.005", cum: "0",
      }],
    }]);
    vi.spyOn(client, "account").mockResolvedValue({
      assets: [
        { asset: "USDT", walletBalance: "600", availableBalance: "500" },
        { asset: "BNB", walletBalance: "1", availableBalance: "1" },
      ],
      totalWalletBalance: "1000",
      totalMarginBalance: "1000",
      availableBalance: "900",
      totalPositionInitialMargin: "0",
    });
    placeOrder.mockImplementation(async (request) => ({
      symbol: request.symbol, orderId: 150, clientOrderId: request.newClientOrderId ?? "account-entry",
      price: request.price ?? "0", origQty: request.quantity, executedQty: "0", status: "NEW",
      side: request.side, positionSide: request.positionSide, type: request.type,
    }));
    const store = finalGateDatabase({ leverageMode: "ACCOUNT_CONFIGURED", fixedLeverage: 20 });
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
        maintenanceBracket: 1,
        maintMarginRatio: "0.005",
        cumMaintenance: "0",
        reservedMargin: "9.724666666666666666666666666666",
        compatibilityFrozen: false,
      });
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
    } finally {
      await services.stop();
    }
  });
});
