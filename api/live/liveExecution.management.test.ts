import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import type { BinanceOpenOrder, BinancePositionRisk, PlaceOrderRequest } from "./binanceSigned";
import { MainnetLiveExecutionAdapter } from "./liveExecution";
import { InMemoryLiveOrderStore, type LivePositionSeed } from "./orderStateMachine";

const NOW = 1_800_000_000_000;
const seed: LivePositionSeed = {
  id: "intent-live", signalId: "signal-live", strategyType: "SWING", symbol: "BTCUSDT", side: "LONG",
  stopPrice: "95", liquidationPrice: "50", leverage: "5", maintenanceBracket: 1,
  maintMarginRatio: "0.01", cumMaintenance: "0", tickSize: "0.01",
};

function harness(mark = "100", openedAt = NOW - 60_000) {
  const store = new InMemoryLiveOrderStore();
  const placed: PlaceOrderRequest[] = [];
  let remoteMark = mark;
  const remote: BinancePositionRisk = {
    symbol: "BTCUSDT", positionAmt: "1", entryPrice: "100", markPrice: remoteMark,
    liquidationPrice: "50", leverage: "5", marginType: "isolated", isolatedWallet: "20",
  };
  const gateway = {
    account: async () => ({ assets: [{ asset: "USDT", walletBalance: "1000", availableBalance: "980" }] }),
    positionRisk: async () => [{ ...remote, markPrice: remoteMark }],
    placeOrder: async (request: PlaceOrderRequest): Promise<BinanceOpenOrder> => {
      placed.push(request);
      return {
        symbol: request.symbol, orderId: 100 + placed.length, clientOrderId: request.newClientOrderId ?? "order",
        price: request.price ?? "0", origQty: request.quantity, executedQty: "0", status: "NEW",
        side: request.side, type: request.type, reduceOnly: request.reduceOnly,
      };
    },
    cancelOrder: async (request: { symbol: string; origClientOrderId?: string }) => ({
      symbol: request.symbol, orderId: 999, clientOrderId: request.origClientOrderId ?? "order", price: "95",
      origQty: "1", executedQty: "0", status: "CANCELED", side: "SELL", type: "STOP_MARKET", reduceOnly: true,
    }),
    queryOrder: async (request: { symbol: string; origClientOrderId?: string }) => ({
      symbol: request.symbol, orderId: 999, clientOrderId: request.origClientOrderId ?? "order", price: "95",
      origQty: "1", executedQty: "0", status: "CANCELED", side: "SELL", type: "STOP_MARKET", reduceOnly: true,
    }),
    userTrades: async () => [],
  };
  const dayKey = new Date(NOW).toISOString().slice(0, 10);
  const daily = new Map<string, { dayStartEquity: number; dailyLocked: boolean }>([
    [dayKey, { dayStartEquity: 1000, dailyLocked: false }],
  ]);
  const adapter = new MainnetLiveExecutionAdapter({
    store,
    gateway,
    workerId: "worker",
    now: () => NOW,
    getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "FIXED", fixedLeverage: 5, dailyLossLimitPct: 1 }),
    accounting: { listLedgerEntries: async () => [] },
    dailyRisk: {
      evaluate: async (dayKey: string, equity: number, dailyLossLimitPct: number) => {
        const current = daily.get(dayKey) ?? { dayStartEquity: equity, dailyLocked: false };
        if ((equity - current.dayStartEquity) / current.dayStartEquity * 100 <= -dailyLossLimitPct) current.dailyLocked = true;
        daily.set(dayKey, current);
        return current;
      },
    },
    assertCurrentAdmission: async () => undefined,
    createIntent: async () => { throw new Error("not used"); },
    claimIntent: async () => { throw new Error("not used"); },
    pauseAutoTrade: async () => undefined,
    prepareIntent: () => { throw new Error("not used"); },
    finalGate: () => { throw new Error("not used"); },
  });
  return {
    adapter, store, placed, remote, gateway,
    setMark: (value: string) => { remoteMark = value; },
    open: async () => {
      store.addOrder({
        id: "entry-row", intentId: seed.id, clientOrderId: "entry-live", exchangeOrderId: "1",
        symbol: seed.symbol, side: seed.side, type: "LIMIT", status: "FILLED", price: "100",
        stopPrice: null, originalQuantity: "1", executedQuantity: "0", averagePrice: "0", commission: "0",
        reduceOnly: false, createdAt: openedAt,
      });
      await store.applyFill("entry-row", {
        exchangeTradeId: "trade-1", exchangeOrderId: "1", symbol: "BTCUSDT", side: "BUY", price: "100",
        quantity: "1", commission: "0", commissionAsset: "USDT", realizedPnl: "0", isMaker: false, executedAt: openedAt,
      }, seed);
    },
  };
}

describe("signed LIVE account and position management", () => {
  it("reports signed unrealized PnL/margin and persists a daily loss lock", async () => {
    const h = harness();
    await h.open();
    await h.adapter.account();
    h.setMark("90");

    const account = await h.adapter.account();

    expect(account).toMatchObject({
      equity: 990, unrealizedPnl: -10, usedMargin: 20, todayPnl: -10, todayPnlPct: -1, dailyLocked: true,
    });
  });

  it("manages daily-loss, 2.2R and 72-hour exits through reduceOnly orders", async () => {
    const daily = harness("90");
    await daily.open();
    await daily.adapter.manage();
    expect(daily.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true, side: "SELL" });

    const target = harness("121");
    await target.open();
    await target.adapter.manage();
    expect(target.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true });

    const timeout = harness("100", NOW - 73 * 60 * 60_000);
    await timeout.open();
    await timeout.adapter.manage();
    expect(timeout.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true });
  });

  it("returns an unavailable LIVE snapshot instead of stale marks or zero PnL when signed REST fails", async () => {
    const h = harness();
    await h.open();
    h.gateway.account = async () => { throw new Error("offline"); };
    h.gateway.positionRisk = async () => { throw new Error("offline"); };

    const snapshot = await h.adapter.snapshot();

    expect(snapshot.account).toMatchObject({ valuationValid: false, dailyLocked: true });
    expect(snapshot.account.equity).toBeNaN();
    expect(snapshot.account.unrealizedPnl).toBeNaN();
    expect(snapshot.positions[0]).toMatchObject({ valuationValid: false, unrealizedPnl: Number.NaN });
    expect(snapshot.positions[0]?.markPrice).toBeNaN();
  });

  it("persists a tick-normalized trailing stop and replaces native protection", async () => {
    const h = harness("110.004");
    await h.open();

    await h.adapter.manage();

    expect(await h.store.getPosition(seed.id)).toMatchObject({ stopPrice: "104.5", markPrice: "110.004" });
    expect(h.placed.some((order) => order.type === "STOP_MARKET" && order.stopPrice === "104.5")).toBe(true);
  });
});
