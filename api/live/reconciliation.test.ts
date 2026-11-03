import { describe, expect, it } from "vitest";
import type { BinanceAccountResponse, BinanceOpenOrder, BinancePositionRisk } from "./binanceSigned";
import {
  InMemoryReconciliationStore,
  LiveEntryAdmission,
  ReconciliationService,
} from "./reconciliation";
import {
  InMemoryLiveOrderStore,
  type LiveOrder,
  type LiveOrderStatus,
  type LivePositionSeed,
} from "./orderStateMachine";

function order(status: LiveOrderStatus, suffix = "1"): LiveOrder {
  return {
    id: `order-${suffix}`,
    intentId: `intent-${suffix}`,
    clientOrderId: `client-${suffix}`,
    exchangeOrderId: status === "PENDING_SEND" || status === "SUBMITTING" ? null : `90${suffix}`,
    symbol: "BTCUSDT",
    side: "LONG",
    type: "LIMIT",
    status,
    price: "100",
    stopPrice: null,
    originalQuantity: "1",
    executedQuantity: "0",
    averagePrice: "0",
    commission: "0",
    reduceOnly: false,
    createdAt: 1,
  };
}

function remoteOrder(local: LiveOrder, suffix = "1"): BinanceOpenOrder {
  return {
    symbol: local.symbol,
    orderId: Number(`90${suffix}`),
    clientOrderId: local.clientOrderId,
    price: local.price,
    stopPrice: local.type === "STOP_MARKET" ? local.stopPrice ?? local.price : undefined,
    origQty: local.originalQuantity,
    executedQty: local.executedQuantity,
    status: local.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : "NEW",
    side: "BUY",
    type: local.type,
    reduceOnly: local.reduceOnly,
  };
}

function account(walletBalance = "1000"): BinanceAccountResponse {
  return {
    assets: [{ asset: "USDT", walletBalance, availableBalance: "900", crossWalletBalance: walletBalance }],
  };
}

function position(amount: string): BinancePositionRisk {
  return {
    symbol: "BTCUSDT",
    positionAmt: amount,
    entryPrice: "100",
    markPrice: "101",
    liquidationPrice: "80",
    leverage: "2",
    marginType: "isolated",
  };
}

const seed: LivePositionSeed = {
  id: "intent-1",
  symbol: "BTCUSDT",
  side: "LONG",
  stopPrice: "95",
  liquidationPrice: "80",
  leverage: "2",
  maintenanceBracket: 1,
  maintMarginRatio: "0.01",
  cumMaintenance: "0",
};

interface HarnessOptions {
  statuses?: LiveOrderStatus[];
  remoteOrders?: BinanceOpenOrder[];
  positions?: BinancePositionRisk[];
  account?: BinanceAccountResponse;
  recoverError?: boolean;
  recoverStatus?: LiveOrderStatus;
  restError?: boolean;
  accountingError?: boolean;
  entriesAlreadyPaused?: boolean;
  unsettledIntents?: Array<{ id: string; symbol: string; status: string }>;
}

async function harness(options: HarnessOptions = {}) {
  const orders = new InMemoryLiveOrderStore();
  const store = new InMemoryReconciliationStore(options.unsettledIntents);
  const statuses = options.statuses ?? [];
  const localOrders = statuses.map((status, index) => order(status, String(index + 1)));
  for (const local of localOrders) orders.addOrder(local);
  const calls: string[] = [];
  const recovered: string[] = [];
  const client = {
    account: async () => {
      calls.push("account");
      if (options.restError) throw new Error("offline");
      return options.account ?? account();
    },
    positionRisk: async () => options.positions ?? [],
    openOrders: async () => options.remoteOrders ?? localOrders.filter((local) => local.status !== "PENDING_SEND"
      && local.status !== "SUBMITTING" && local.status !== "UNKNOWN" && local.status !== "RECONCILING")
      .map((local, index) => remoteOrder(local, String(index + 1))),
  };
  const service = new ReconciliationService({
    client,
    orders,
    store,
    recovery: {
      recover: async (clientOrderId) => {
        recovered.push(clientOrderId);
        if (options.recoverError) throw new Error("UNKNOWN");
        const latest = await orders.getOrder(clientOrderId);
        if (!latest) throw new Error("missing");
        const recoveredStatus = options.recoverStatus
          ?? (["UNKNOWN", "RECONCILING", "REPLACE"].includes(latest.status) ? "NEW" : latest.status);
        return orders.transitionOrder(clientOrderId, [latest.status], { status: recoveredStatus })
          .then((updated) => updated ?? latest);
      },
    },
    accounting: {
      synchronize: async () => {
        calls.push("accounting");
        if (options.accountingError) throw new Error("accounting offline");
      },
    },
    pauseNewEntries: async () => {
      calls.push("pause");
      if (options.entriesAlreadyPaused) return null;
      return {
        resume: async () => {
          calls.push("allow");
          return true;
        },
        discard: async () => undefined,
      };
    },
    now: () => 5_000,
  });
  return { service, orders, store, calls, recovered, localOrders };
}

describe("startup reconciliation", () => {
  it("recovers every nonterminal order state only after pausing new entries", async () => {
    const statuses: LiveOrderStatus[] = [
      "PENDING_SEND",
      "SUBMITTING",
      "NEW",
      "PARTIALLY_FILLED",
      "UNKNOWN",
      "RECONCILING",
      "REPLACE",
    ];
    const remoteOrders = statuses.map((status, index) => remoteOrder(order(status, String(index + 1)), String(index + 1)));
    const h = await harness({ statuses, remoteOrders });

    const result = await h.service.reconcile();

    expect(h.calls[0]).toBe("pause");
    expect(h.calls.indexOf("pause")).toBeLessThan(h.calls.indexOf("account"));
    expect(h.recovered).toHaveLength(7);
    expect(h.calls.at(-1)).toBe("allow");
    expect(result.ok).toBe(true);
  });

  it("synchronizes accounting before allowing new entries", async () => {
    const h = await harness();

    const result = await h.service.reconcile();

    expect(result.ok).toBe(true);
    expect(h.calls).toContain("accounting");
    expect(h.calls.indexOf("accounting")).toBeGreaterThan(h.calls.indexOf("pause"));
    expect(h.calls.indexOf("accounting")).toBeLessThan(h.calls.indexOf("allow"));
  });

  it("does not resume when accounting synchronization fails", async () => {
    const h = await harness({ accountingError: true });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
  });

  it("keeps admission frozen when recovery cannot resolve UNKNOWN", async () => {
    const h = await harness({ statuses: ["UNKNOWN"], recoverError: true });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues()).some((issue) => issue.category === "UNSETTLED_INTENT")).toBe(true);
  });

  it("rejects a recovered UNKNOWN result even when openOrders contains the order", async () => {
    const remote = remoteOrder(order("UNKNOWN"));
    const h = await harness({ statuses: ["UNKNOWN"], recoverStatus: "UNKNOWN", remoteOrders: [remote] });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues()).some((issue) => issue.category === "UNSETTLED_INTENT")).toBe(true);
  });

  it("does not treat a stuck REPLACE result as clean recovery", async () => {
    const h = await harness({ statuses: ["REPLACE"], recoverStatus: "REPLACE" });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.recovered).toHaveLength(1);
    expect(h.calls).not.toContain("allow");
  });

  it("stays frozen when the REST snapshot fails", async () => {
    const h = await harness({ restError: true });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues())[0]?.category).toBe("REST_RECONCILIATION");
  });

  it("resolves recovered transport issues without clearing unrelated position or order findings", async () => {
    const h = await harness();
    await h.store.recordIssue({
      category: "REST_RECONCILIATION", severity: "CRITICAL", symbol: null,
      expectedValue: null, actualValue: null, message: "previous transport failure", detectedAt: 1,
    });
    await h.store.recordIssue({
      category: "UNKNOWN_MANUAL_ORDER", severity: "CRITICAL", symbol: "BTCUSDT",
      expectedValue: null, actualValue: null, message: "external order remains", detectedAt: 1,
    });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(true);
    expect(await h.store.listIssues()).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "REST_RECONCILIATION", status: "RESOLVED" }),
      expect.objectContaining({ category: "UNKNOWN_MANUAL_ORDER", status: "OPEN" }),
    ]));
  });

  it("does not resolve a newer transport failure from an older successful round", async () => {
    const h = await harness();
    await h.store.recordIssue({
      category: "REST_RECONCILIATION", severity: "CRITICAL", symbol: null,
      expectedValue: null, actualValue: null, message: "newer failure", detectedAt: 6_000,
    });

    await h.service.reconcile();

    expect(await h.store.listIssues()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "newer failure", status: "OPEN" }),
    ]));
  });

  it("reports a persisted unsettled intent that has no order", async () => {
    const h = await harness({
      unsettledIntents: [{ id: "intent-without-order", symbol: "BTCUSDT", status: "SUBMITTING" }],
    });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues())[0]).toMatchObject({
      category: "UNSETTLED_INTENT",
      symbol: "BTCUSDT",
    });
  });

  it("does not resume an operator pause that predated reconciliation", async () => {
    const h = await harness({ entriesAlreadyPaused: true });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(true);
    expect(h.calls).not.toContain("allow");
  });
});

describe("entry admission resume ownership", () => {
  it("gives nested reconciliation pauses a single resume owner", async () => {
    const gate = new LiveEntryAdmission(true);

    const first = await gate.pauseForReconciliation();
    const nested = await gate.pauseForReconciliation();

    expect(first).not.toBeNull();
    expect(nested).toBeNull();
    expect(gate.allowed).toBe(false);
    expect(await first?.resume()).toBe(true);
    expect(gate.allowed).toBe(true);
  });

  it("invalidates abandoned A so current B owns admission and failed B stays paused", async () => {
    const gate = new LiveEntryAdmission(true);
    const attemptA = await gate.pauseForReconciliation();

    await gate.suspend();
    const attemptB = await gate.pauseForReconciliation();

    expect(attemptB).not.toBeNull();
    expect(await attemptA?.resume()).toBe(false);
    await attemptB?.discard();
    expect(gate.allowed).toBe(false);
  });

  it("invalidates a stale resume token when an operator pauses during REST", async () => {
    const gate = new LiveEntryAdmission(true);
    const token = await gate.pauseForReconciliation();

    await gate.pauseFromOperator();

    expect(await token?.resume()).toBe(false);
    expect(gate.allowed).toBe(false);
  });

  it("releases failed-attempt ownership so a clean retry can resume", async () => {
    const gate = new LiveEntryAdmission(true);
    const store = new InMemoryReconciliationStore();
    const orders = new InMemoryLiveOrderStore();
    const manual = remoteOrder(order("NEW", "9"), "9");
    manual.clientOrderId = "manual-order";
    let externalOrder = true;
    const service = new ReconciliationService({
      client: {
        account: async () => account(),
        positionRisk: async () => [],
        openOrders: async () => externalOrder ? [manual] : [],
      },
      orders,
      store,
      recovery: { recover: async () => { throw new Error("unexpected"); } },
      accounting: { synchronize: async () => undefined },
      pauseNewEntries: () => gate.pauseForReconciliation(),
    });

    expect((await service.reconcile()).ok).toBe(false);
    expect(gate.allowed).toBe(false);
    externalOrder = false;
    expect((await service.reconcile()).ok).toBe(true);

    expect(gate.allowed).toBe(true);
  });

  it("does not let reconciliation overwrite an operator pause during account retrieval", async () => {
    const gate = new LiveEntryAdmission(true);
    const store = new InMemoryReconciliationStore();
    const orders = new InMemoryLiveOrderStore();
    const service = new ReconciliationService({
      client: {
        account: async () => {
          await gate.pauseFromOperator();
          return account();
        },
        positionRisk: async () => [],
        openOrders: async () => [],
      },
      orders,
      store,
      recovery: { recover: async () => { throw new Error("unexpected"); } },
      accounting: { synchronize: async () => undefined },
      pauseNewEntries: () => gate.pauseForReconciliation(),
    });

    const result = await service.reconcile();

    expect(result.ok).toBe(true);
    expect(gate.allowed).toBe(false);
  });
});

describe("exchange and database comparison", () => {
  it("reports an unknown manual order without taking it over", async () => {
    const manual = remoteOrder(order("NEW", "9"), "9");
    manual.clientOrderId = "manual-order";
    const h = await harness({ remoteOrders: [manual] });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.recovered).toEqual([]);
    expect((await h.store.listIssues())[0]).toMatchObject({
      category: "UNKNOWN_MANUAL_ORDER",
      status: "OPEN",
      severity: "CRITICAL",
    });
  });

  it("reports quantity and executed-fill differences for a known working order", async () => {
    const local = order("PARTIALLY_FILLED");
    const remote = remoteOrder(local);
    remote.origQty = "2";
    remote.executedQty = "0.5";
    const h = await harness({ statuses: ["PARTIALLY_FILLED"], remoteOrders: [remote] });
    await h.orders.applyFill("order-1", {
      exchangeTradeId: "1",
      exchangeOrderId: "901",
      symbol: "BTCUSDT",
      side: "BUY",
      price: "100",
      quantity: "0.25",
      commission: "0.01",
      commissionAsset: "USDT",
      realizedPnl: "0",
      isMaker: false,
      executedAt: 100,
    }, seed);

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues()).find((issue) => issue.category === "ORDER_MISMATCH"))
      .toMatchObject({ expectedValue: "0.25", actualValue: "0.5" });
  });

  it("records exact wallet balance differences against the last persisted snapshot", async () => {
    const h = await harness({ account: account("1000.000000000000000000000000000002") });
    await h.store.appendAccountSnapshot({
      asset: "USDT",
      walletBalance: "1000.000000000000000000000000000001",
      availableBalance: "900",
      crossWalletBalance: "1000.000000000000000000000000000001",
      observedAt: 1_000,
    });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).find((issue) => issue.category === "BALANCE_MISMATCH"))
      .toMatchObject({
        expectedValue: "1000.000000000000000000000000000001",
        actualValue: "1000.000000000000000000000000000002",
      });
  });

  it("reports a signed position mismatch", async () => {
    const h = await harness({ positions: [position("-2")] });
    h.orders.addOrder(order("FILLED"));
    await h.orders.applyFill("order-1", {
      exchangeTradeId: "1",
      exchangeOrderId: "901",
      symbol: "BTCUSDT",
      side: "BUY",
      price: "100",
      quantity: "1",
      commission: "0.1",
      commissionAsset: "USDT",
      realizedPnl: "0",
      isMaker: false,
      executedAt: 100,
    }, seed);

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).find((issue) => issue.category === "POSITION_MISMATCH"))
      .toMatchObject({ expectedValue: "1", actualValue: "-2" });
  });

  it("compares SHORT positions using their signed exchange quantity", async () => {
    const h = await harness({ positions: [position("-2")] });
    const shortOrder = { ...order("FILLED"), side: "SHORT" as const };
    h.orders.addOrder(shortOrder);
    await h.orders.applyFill("order-1", {
      exchangeTradeId: "1",
      exchangeOrderId: "901",
      symbol: "BTCUSDT",
      side: "SELL",
      price: "100",
      quantity: "1",
      commission: "0.1",
      commissionAsset: "USDT",
      realizedPnl: "0",
      isMaker: false,
      executedAt: 100,
    }, { ...seed, side: "SHORT" });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).find((issue) => issue.category === "POSITION_MISMATCH"))
      .toMatchObject({ expectedValue: "-1", actualValue: "-2" });
  });

  it("only freezes and reports an unknown manual position", async () => {
    const h = await harness({ positions: [position("3")] });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues())[0]).toMatchObject({
      category: "UNKNOWN_MANUAL_POSITION",
      expectedValue: "0",
      actualValue: "3",
    });
  });

  it("reports an open position without a covering native reduceOnly stop", async () => {
    const h = await harness({ positions: [position("1")] });
    h.orders.addOrder(order("FILLED"));
    await h.orders.applyFill("order-1", {
      exchangeTradeId: "1",
      exchangeOrderId: "901",
      symbol: "BTCUSDT",
      side: "BUY",
      price: "100",
      quantity: "1",
      commission: "0.1",
      commissionAsset: "USDT",
      realizedPnl: "0",
      isMaker: false,
      executedAt: 100,
    }, seed);

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).some((issue) => issue.category === "UNPROTECTED_POSITION")).toBe(true);
  });

  it("after restart rejects a native stop whose price differs from the persisted protection", async () => {
    const protection = {
      ...order("NEW", "2"), intentId: seed.id, clientOrderId: "protect-intent-1",
      exchangeOrderId: "902", type: "STOP_MARKET" as const, reduceOnly: true, price: "95", stopPrice: "95",
    };
    const remoteProtection = { ...remoteOrder(protection, "2"), side: "SELL", stopPrice: "94" };
    const h = await harness({ positions: [position("1")], remoteOrders: [remoteProtection] });
    h.orders.addOrder(order("FILLED"));
    h.orders.addOrder(protection);
    await h.orders.applyFill("order-1", {
      exchangeTradeId: "1", exchangeOrderId: "901", symbol: "BTCUSDT", side: "BUY", price: "100",
      quantity: "1", commission: "0", commissionAsset: "USDT", realizedPnl: "0", isMaker: false, executedAt: 100,
    }, seed);

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).some((issue) => issue.category === "UNPROTECTED_POSITION"
      && issue.message.includes("价格"))).toBe(true);
  });

  it("recovers a missed first fill from a terminal owned order using its persisted intent seed", async () => {
    const orders = new InMemoryLiveOrderStore();
    const store = new InMemoryReconciliationStore();
    const terminal = order("FILLED");
    orders.addOrder(terminal);
    orders.addOrder({
      ...order("NEW", "2"), intentId: terminal.intentId, clientOrderId: "protect-intent-1",
      exchangeOrderId: "902", type: "STOP_MARKET", reduceOnly: true, price: "95", stopPrice: "95",
    });
    const remoteProtection = remoteOrder(order("NEW", "2"), "2");
    Object.assign(remoteProtection, {
      clientOrderId: "protect-intent-1", orderId: 902, type: "STOP_MARKET", reduceOnly: true, side: "SELL",
      stopPrice: "95",
    });
    const service = new ReconciliationService({
      client: {
        account: async () => account(), positionRisk: async () => [position("1")], openOrders: async () => [remoteProtection],
      },
      orders,
      store,
      seedFor: async () => seed,
      recovery: {
        recover: async (clientOrderId, recoverySeed) => {
          if (clientOrderId === terminal.clientOrderId) {
            if (!recoverySeed) throw new Error("Position seed is required for recovered fills");
            await orders.applyFill(terminal.id, {
              exchangeTradeId: "missed-first-fill", exchangeOrderId: "901", symbol: "BTCUSDT", side: "BUY",
              price: "100", quantity: "1", commission: "0", commissionAsset: "USDT", realizedPnl: "0",
              isMaker: false, executedAt: 100,
            }, recoverySeed);
          }
          return (await orders.getOrder(clientOrderId))!;
        },
      },
      accounting: { synchronize: async () => undefined },
      pauseNewEntries: async () => null,
    });

    const result = await service.reconcile();

    expect(result.ok).toBe(true);
    expect(await orders.getPosition(terminal.intentId)).toMatchObject({ quantity: "1", entryPrice: "100" });
  });

  it("treats ledger-explained wallet changes as expected and resolves a recovered balance issue", async () => {
    const orders = new InMemoryLiveOrderStore();
    const store = new InMemoryReconciliationStore();
    await store.appendAccountSnapshot({
      asset: "USDT", walletBalance: "1000", availableBalance: "1000", crossWalletBalance: "1000", observedAt: 1_000,
    });
    const existing = await store.recordIssue({
      category: "BALANCE_MISMATCH", severity: "ERROR", symbol: null,
      expectedValue: "1000", actualValue: "999", message: "USDT wallet balance 与上次持久化快照不一致", detectedAt: 1_100,
    });
    const service = new ReconciliationService({
      client: { account: async () => account("999"), positionRisk: async () => [], openOrders: async () => [] },
      orders,
      store,
      ledger: { listLedgerEntries: async () => [{
        id: "ledger-1", exchangeTransactionId: "income-1", symbol: "BTCUSDT", asset: "USDT",
        entryType: "REALIZED_PNL", amount: "-1", occurredAt: 2_000,
      }] },
      recovery: { recover: async () => { throw new Error("unexpected"); } },
      accounting: { synchronize: async () => undefined },
      pauseNewEntries: async () => null,
      now: () => 3_000,
    });

    const result = await service.reconcile();

    expect(result.ok).toBe(true);
    expect((await store.listIssues()).find((issue) => issue.id === existing.id)?.status).toBe("RESOLVED");
    expect((await store.listIssues()).some((issue) => issue.category === "BALANCE_MISMATCH" && issue.status === "OPEN")).toBe(false);
  });
});
