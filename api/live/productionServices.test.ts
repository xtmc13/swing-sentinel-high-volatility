import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import type { BinanceOpenOrder, BinanceSignedClient, PlaceOrderRequest } from "./binanceSigned";
import type { LiveDatabase } from "./livePersistence";
import { InMemoryLiveOrderStore } from "./orderStateMachine";
import { InMemoryReconciliationStore } from "./reconciliation";
import { InMemoryAccountingStore } from "./accounting";
import { createBinanceProductionLiveServices } from "./productionServices";
import { createProductionLiveRuntime } from "./productionRuntime";
import type { LiveFill, LiveOrder, LivePositionSeed } from "./orderStateMachine";
import type { UserDataSocket } from "./userDataStream";

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
  it("starts reconciliation/private WS, requires a fresh event for readiness, and stops cleanly", async () => {
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
      socketFactory: () => socket,
      now: () => now,
      reconciliationIntervalMs: 60_000,
    });

    await services.start();
    expect(services.reconciliation.health()).toMatchObject({ configured: true, running: true, lastRunAt: now });
    expect((await services.preflight()).ready).toBe(false);

    now += 1;
    socket.emit(JSON.stringify({ e: "ACCOUNT_UPDATE", E: now, a: { B: [{ a: "USDT" }] } }));
    await vi.waitFor(() => expect(services.privateWs.health().lastMessageAt).toBe(now));
    await expect(services.preflight()).resolves.toMatchObject({ ready: true, reasons: [] });

    await services.stop();
    expect(socket.closed).toBe(true);
    expect(services.reconciliation.health().running).toBe(false);
    expect(placeOrder).not.toHaveBeenCalled();
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
      id: "intent-open", symbol: "BTCUSDT", side: "LONG", stopPrice: "99",
      liquidationPrice: "40", leverage: "2", maintenanceBracket: 1,
      maintMarginRatio: "0.01", cumMaintenance: "0",
    };
    const order: LiveOrder = {
      id: "order-row", intentId: seed.id, clientOrderId: "entry-open", exchangeOrderId: "1",
      symbol: seed.symbol, side: seed.side, type: "LIMIT", status: "NEW", price: "100",
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
      accountingStore: new InMemoryAccountingStore(), socketFactory: () => socket,
      now, reconciliationIntervalMs: 60_000, pauseAutoTrade,
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
});
