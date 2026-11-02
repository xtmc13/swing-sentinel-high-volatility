import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import type { BinanceSignedClient } from "./binanceSigned";
import type { LiveDatabase } from "./livePersistence";
import { InMemoryLiveOrderStore } from "./orderStateMachine";
import { InMemoryReconciliationStore } from "./reconciliation";
import { InMemoryAccountingStore } from "./accounting";
import { createBinanceProductionLiveServices } from "./productionServices";
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
  const placeOrder = vi.fn(async () => { throw new Error("no orders in composition test"); });
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
});
