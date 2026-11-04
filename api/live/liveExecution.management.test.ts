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
  const alerts: string[] = [];
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
    alert: (message) => alerts.push(message),
    assertCurrentAdmission: async () => undefined,
    createIntent: async () => { throw new Error("not used"); },
    claimIntent: async () => { throw new Error("not used"); },
    pauseAutoTrade: async () => undefined,
    prepareIntent: () => { throw new Error("not used"); },
    finalGate: () => { throw new Error("not used"); },
  });
  return {
    adapter, store, placed, remote, gateway, alerts,
    setMark: (value: string) => { remoteMark = value; },
    protect: () => {
      store.addOrder({
        id: "protection-row", intentId: seed.id, clientOrderId: "protect-intent-live", exchangeOrderId: "2",
        symbol: seed.symbol, side: seed.side, type: "STOP_MARKET", status: "NEW", price: "95",
        stopPrice: "95", originalQuantity: "1", executedQuantity: "0", averagePrice: "0", commission: "0",
        reduceOnly: true, createdAt: openedAt,
      });
    },
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

  it("accepts a successfully signed zero-balance account while keeping new risk locked", async () => {
    const h = harness();
    h.gateway.account = async () => ({ assets: [{ asset: "USDT", walletBalance: "0", availableBalance: "0.00009186" }] });
    h.gateway.positionRisk = async () => [];

    await expect(h.adapter.account()).resolves.toMatchObject({
      equity: 0,
      cash: 0,
      availableMargin: 0.00009186,
      usedMargin: 0,
      unrealizedPnl: 0,
      valuationValid: true,
      valuationIssues: [],
      dailyLocked: true,
    });
  });

  it("uses Binance account-wide totals instead of dropping non-USDT wallet balances", async () => {
    const h = harness();
    h.gateway.account = async () => ({
      assets: [
        { asset: "USDT", walletBalance: "0", availableBalance: "0" },
        { asset: "USDC", walletBalance: "0.00009177", availableBalance: "0.00009174" },
      ],
      totalWalletBalance: "0.00009174",
      totalMarginBalance: "0.00009174",
      availableBalance: "0.00009174",
    });
    h.gateway.positionRisk = async () => [];

    await expect(h.adapter.account()).resolves.toMatchObject({
      equity: 0.00009174,
      cash: 0.00009174,
      availableMargin: 0.00009174,
      valuationValid: true,
    });
  });

  it("rejects an invalid signed equity instead of treating it as a real zero", async () => {
    const h = harness();
    h.gateway.account = async () => ({ assets: [{ asset: "USDT", walletBalance: "unavailable", availableBalance: "unavailable" }] });
    h.gateway.positionRisk = async () => [];

    await expect(h.adapter.account()).resolves.toMatchObject({
      equity: 0,
      valuationValid: false,
      valuationIssues: ["签名 LIVE 账户或持仓估值不可用"],
      dailyLocked: true,
    });
  });

  it("returns zero display values without clearing unavailable flags when signed REST fails", async () => {
    const h = harness();
    await h.open();
    h.gateway.account = async () => { throw new Error("offline"); };
    h.gateway.positionRisk = async () => { throw new Error("offline"); };

    const snapshot = await h.adapter.snapshot();

    expect(snapshot.account).toEqual({
      equity: 0,
      cash: 0,
      availableMargin: 0,
      usedMargin: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      todayPnl: 0,
      todayPnlPct: 0,
      dayStartEquity: 0,
      valuationValid: false,
      valuationIssues: ["签名 LIVE 账户或持仓估值不可用"],
      dailyLocked: true,
    });
    expect(snapshot.positions[0]).toMatchObject({
      qty: 1,
      initialQty: 1,
      entryPrice: 100,
      markPrice: 0,
      stopPrice: 95,
      targetPrice: 111,
      liquidationPrice: 50,
      leverage: 5,
      margin: 0,
      unrealizedPnl: 0,
      unrealizedPct: 0,
      realizedPnl: 0,
      rMultiple: 0,
      valuationValid: false,
    });
    expect(await h.store.getPosition(seed.id)).toMatchObject({ quantity: "1" });
  });

  it("tightens through tick normalization and persists only after NEW confirmation", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();

    await expect(h.adapter.tightenStop(seed.id, 104.004, "衰竭收紧")).resolves.toMatchObject({ ok: true, changed: true });

    expect(h.placed.at(-1)).toMatchObject({ type: "STOP_MARKET", stopPrice: "104", reduceOnly: true });
    expect(await h.store.getPosition(seed.id)).toMatchObject({ stopPrice: "104" });
  });

  it("skips equal, looser, mark-crossing and exit-pending stop changes without exchange requests", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();

    await expect(h.adapter.tightenStop(seed.id, 95, "相同")).resolves.toMatchObject({ ok: true, changed: false });
    await expect(h.adapter.tightenStop(seed.id, 94, "宽松")).resolves.toMatchObject({ ok: true, changed: false });
    await expect(h.adapter.tightenStop(seed.id, 111, "越价")).resolves.toMatchObject({ ok: true, changed: false });
    await h.store.updatePosition(seed.id, { exitPending: true });
    await expect(h.adapter.tightenStop(seed.id, 104, "退出中")).resolves.toMatchObject({ ok: true, changed: false });

    expect(h.placed.filter((order) => order.type === "STOP_MARKET")).toHaveLength(0);
  });

  it("two adapters sharing a store cannot finish a looser stop after a tighter one", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();
    const second = new MainnetLiveExecutionAdapter({
      store: h.store,
      gateway: h.gateway,
      workerId: "worker-b",
      now: () => NOW,
      alert: (message) => h.alerts.push(message),
      assertCurrentAdmission: async () => undefined,
      createIntent: async () => { throw new Error("not used"); },
      claimIntent: async () => { throw new Error("not used"); },
      pauseAutoTrade: async () => undefined,
      prepareIntent: () => { throw new Error("not used"); },
      finalGate: () => { throw new Error("not used"); },
    });
    const cancel = h.gateway.cancelOrder;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cancelling = new Promise<void>((resolve) => { started = resolve; });
    let paused = false;
    h.gateway.cancelOrder = async (request) => {
      if (!paused) {
        paused = true;
        started();
        await gate;
      }
      return cancel(request);
    };

    const first = h.adapter.tightenStop(seed.id, 104, "first");
    await cancelling;
    const tighter = second.tightenStop(seed.id, 105, "second");
    release();
    await Promise.all([first, tighter]);

    expect(await h.store.getPosition(seed.id)).toMatchObject({ stopPrice: "105" });
  });

  it("an exit claim arriving during cancel prevents the stop replacement", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();
    const cancel = h.gateway.cancelOrder;
    h.gateway.cancelOrder = async (request) => {
      const result = await cancel(request);
      await h.store.updatePosition(seed.id, { exitPending: true });
      return result;
    };

    await expect(h.adapter.tightenStop(seed.id, 104, "衰竭收紧")).resolves.toMatchObject({ ok: true, changed: false });

    expect(h.placed.filter((order) => order.type === "STOP_MARKET")).toHaveLength(0);
    expect(await h.store.getPosition(seed.id)).toMatchObject({ stopPrice: "95", exitPending: true });
  });

  it("persists a trailing stop only after the exchange confirms its NEW replacement", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();
    const placeOrder = h.gateway.placeOrder;
    let persistedAtTransport: string | undefined;
    h.gateway.placeOrder = async (request) => {
      if (request.type === "STOP_MARKET") {
        persistedAtTransport = (await h.store.getPosition(seed.id))?.stopPrice;
      }
      return placeOrder(request);
    };

    await h.adapter.manage();

    expect(persistedAtTransport).toBe("95");
    expect(await h.store.getPosition(seed.id)).toMatchObject({ stopPrice: "104.5", markPrice: "110.004" });
    expect(h.placed.some((order) => order.type === "STOP_MARKET" && order.stopPrice === "104.5")).toBe(true);
  });

  it("cancel timeout leaves the persisted stop unchanged and escalates to reduceOnly exit", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();
    h.gateway.cancelOrder = async () => { throw new Error("cancel timeout"); };

    await h.adapter.manage();

    expect(await h.store.getPosition(seed.id)).toMatchObject({ stopPrice: "95" });
    expect(h.alerts.length).toBeGreaterThan(0);
    expect(h.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true, side: "SELL" });
  });

  it("replacement UNKNOWN cannot silently diverge from the persisted stop", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();
    const placeOrder = h.gateway.placeOrder;
    h.gateway.placeOrder = async (request) => {
      if (request.type === "STOP_MARKET") throw new Error("replacement timeout");
      return placeOrder(request);
    };

    await h.adapter.manage();

    expect(await h.store.getPosition(seed.id)).toMatchObject({ stopPrice: "95" });
    expect(h.alerts.length).toBeGreaterThan(0);
    expect(h.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true, side: "SELL" });
  });

  it("a DB failure after NEW protection triggers alert and reduceOnly exit", async () => {
    const h = harness("110.004");
    await h.open();
    h.protect();
    const updatePosition = h.store.updatePosition.bind(h.store);
    h.store.updatePosition = async (id, patch) => {
      if (patch.stopPrice !== undefined) throw new Error("database offline");
      return updatePosition(id, patch);
    };

    await h.adapter.manage();

    expect(h.placed.some((order) => order.type === "STOP_MARKET" && order.stopPrice === "104.5")).toBe(true);
    expect(h.alerts.length).toBeGreaterThan(0);
    expect(h.placed.at(-1)).toMatchObject({ type: "MARKET", reduceOnly: true, side: "SELL" });
  });
});
