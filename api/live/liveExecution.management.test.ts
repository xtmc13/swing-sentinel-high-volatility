import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@contracts/trading";
import type { BinanceOpenOrder, BinancePositionRisk, PlaceOrderRequest } from "./binanceSigned";
import { MainnetLiveExecutionAdapter } from "./liveExecution";
import { InMemoryLiveOrderStore, type LivePositionSeed } from "./orderStateMachine";

const NOW = 1_800_000_000_000;
const ACCOUNT_MODE = { dualSide: false, fingerprint: "0".repeat(64) } as const;
const seed: LivePositionSeed = {
  id: "intent-live", signalId: "signal-live", strategyType: "SWING", symbol: "BTCUSDT", side: "LONG",
  positionSide: "LONG", entrySemantics: "ENTRY", accountModeFingerprint: ACCOUNT_MODE.fingerprint,
  stopPrice: "95", liquidationPrice: "50", leverage: "5", maintenanceBracket: 1,
  maintMarginRatio: "0.01", cumMaintenance: "0", tickSize: "0.01",
};

function harness(
  mark = "100",
  openedAt = NOW - 60_000,
  accountMode: typeof ACCOUNT_MODE | { dualSide: true; fingerprint: string } = ACCOUNT_MODE,
) {
  const store = new InMemoryLiveOrderStore();
  const placed: PlaceOrderRequest[] = [];
  const alerts: string[] = [];
  const positionSeed = { ...seed, accountModeFingerprint: accountMode.fingerprint };
  let remoteMark = mark;
  const remote: BinancePositionRisk = {
    symbol: "BTCUSDT", positionSide: accountMode.dualSide ? "LONG" : "BOTH",
    positionAmt: "1", entryPrice: "100", markPrice: remoteMark,
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
        side: request.side, positionSide: request.positionSide, type: request.type, reduceOnly: request.reduceOnly,
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
    accountMode,
    createIntent: async () => { throw new Error("not used"); },
    claimIntent: async () => { throw new Error("not used"); },
    pauseAutoTrade: async () => undefined,
    prepareIntent: () => { throw new Error("not used"); },
    finalGate: () => { throw new Error("not used"); },
  });
  return {
    adapter, store, placed, remote, gateway, alerts, positionSeed,
    setMark: (value: string) => { remoteMark = value; },
    protect: () => {
      store.addOrder({
        id: "protection-row", intentId: positionSeed.id, clientOrderId: "protect-intent-live", exchangeOrderId: "2",
        symbol: positionSeed.symbol, side: positionSeed.side, positionSide: positionSeed.positionSide, entrySemantics: "REDUCE",
        accountModeFingerprint: positionSeed.accountModeFingerprint, type: "STOP_MARKET", status: "NEW", price: "95",
        stopPrice: "95", originalQuantity: "1", executedQuantity: "0", averagePrice: "0", commission: "0",
        reduceOnly: true, createdAt: openedAt,
      });
    },
    open: async () => {
      store.addOrder({
        id: "entry-row", intentId: positionSeed.id, clientOrderId: "entry-live", exchangeOrderId: "1",
        symbol: positionSeed.symbol, side: positionSeed.side, positionSide: positionSeed.positionSide, entrySemantics: "ENTRY",
        accountModeFingerprint: positionSeed.accountModeFingerprint, type: "LIMIT", status: "FILLED", price: "100",
        stopPrice: null, originalQuantity: "1", executedQuantity: "0", averagePrice: "0", commission: "0",
        reduceOnly: false, createdAt: openedAt,
      });
      await store.applyFill("entry-row", {
        exchangeTradeId: "trade-1", exchangeOrderId: "1", symbol: "BTCUSDT", side: "BUY", price: "100",
        quantity: "1", commission: "0", commissionAsset: "USDT", realizedPnl: "0", isMaker: false, executedAt: openedAt,
      }, positionSeed);
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
      accountMode: ACCOUNT_MODE,
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

  it("selects the dual LONG REST position instead of an opposite external SHORT position", async () => {
    const h = harness("100", NOW - 60_000, { dualSide: true, fingerprint: "1".repeat(64) });
    await h.open();
    h.gateway.positionRisk = async () => [
      { ...h.remote, positionSide: "SHORT", positionAmt: "-9", markPrice: "999" },
      { ...h.remote, positionSide: "LONG", positionAmt: "1", markPrice: "101" },
    ];

    const positions = await h.adapter.positions();

    expect(positions).toMatchObject([{ side: "LONG", qty: 1, markPrice: 101, valuationValid: true }]);
    expect(await h.store.getPosition(seed.id)).toMatchObject({ side: "LONG", quantity: "1", markPrice: "101" });
  });

  it.each([
    { mode: "one-way", accountMode: ACCOUNT_MODE, positionSide: "LONG" },
    { mode: "one-way", accountMode: ACCOUNT_MODE, positionSide: undefined },
    { mode: "dual", accountMode: { dualSide: true, fingerprint: "1".repeat(64) }, positionSide: "BOTH" },
    { mode: "dual", accountMode: { dualSide: true, fingerprint: "1".repeat(64) }, positionSide: "SHORT" },
    { mode: "dual", accountMode: { dualSide: true, fingerprint: "1".repeat(64) }, positionSide: undefined },
  ] as const)("rejects $mode REST positionSide $positionSide for a managed LONG position", async ({ accountMode, positionSide }) => {
    const h = harness("100", NOW - 60_000, accountMode);
    await h.open();
    h.gateway.positionRisk = async () => [{ ...h.remote, positionSide, positionAmt: "1", markPrice: "101" }];

    const positions = await h.adapter.positions();

    expect(positions).toMatchObject([{ side: "LONG", markPrice: 0, valuationValid: false }]);
    expect(await h.store.getPosition(seed.id)).toMatchObject({ quantity: "1", markPrice: "100" });
  });

  it("stale-fingerprint restart management performs zero protection or close transport", async () => {
    const staleMode = { dualSide: false, fingerprint: "1".repeat(64) } as const;
    const h = harness("110", NOW - 60_000, staleMode);
    await h.open();
    h.protect();
    const cancellations: string[] = [];
    const cancelOrder = h.gateway.cancelOrder;
    h.gateway.cancelOrder = async (request) => {
      cancellations.push(request.origClientOrderId ?? "missing");
      return cancelOrder(request);
    };
    const restarted = new MainnetLiveExecutionAdapter({
      store: h.store,
      gateway: h.gateway,
      workerId: "worker-restarted",
      now: () => NOW,
      getSettings: async () => ({ ...DEFAULT_SETTINGS, executionMode: "LIVE_MAINNET", leverageMode: "FIXED", fixedLeverage: 5 }),
      accounting: { listLedgerEntries: async () => [] },
      dailyRisk: { evaluate: async (_dayKey, equity) => ({ dayStartEquity: equity, dailyLocked: false }) },
      alert: (message) => h.alerts.push(message),
      assertCurrentAdmission: async () => undefined,
      accountMode: ACCOUNT_MODE,
      createIntent: async () => { throw new Error("not used"); },
      claimIntent: async () => { throw new Error("not used"); },
      pauseAutoTrade: async () => undefined,
      prepareIntent: () => { throw new Error("not used"); },
      finalGate: () => { throw new Error("not used"); },
    });

    await expect(restarted.manage()).rejects.toThrow("fingerprint");
    await expect(restarted.tightenStop(seed.id, 104, "重启后收紧")).rejects.toThrow("fingerprint");

    expect(cancellations).toHaveLength(0);
    expect(h.placed).toHaveLength(0);
  });

  it.each([
    { name: "legacy-null fingerprint", patch: { accountModeFingerprint: null } },
    { name: "wrong semantics", patch: { entrySemantics: "ENTRY" } },
    { name: "legacy-null semantics", patch: { entrySemantics: null } },
  ] as const)("live trailing-stop discovery freezes and alerts for $name", async ({ patch }) => {
    const h = harness("110");
    await h.open();
    h.protect();
    const cancellations: string[] = [];
    const cancelOrder = h.gateway.cancelOrder;
    h.gateway.cancelOrder = async (request) => {
      cancellations.push(request.origClientOrderId ?? "missing");
      return cancelOrder(request);
    };
    await h.store.transitionOrder("protect-intent-live", ["NEW"], patch);

    await expect(h.adapter.tightenStop(seed.id, 104, "身份校验")).resolves.toMatchObject({ ok: false, changed: false });

    expect(h.alerts.length).toBeGreaterThan(0);
    expect(cancellations).toHaveLength(0);
  });
});
