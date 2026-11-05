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
    positionSide: "LONG",
    entrySemantics: "ENTRY",
    accountModeFingerprint: "0".repeat(64),
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
    positionSide: "BOTH",
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
    positionSide: "BOTH",
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
  positionSide: "LONG",
  entrySemantics: "ENTRY",
  accountModeFingerprint: "0".repeat(64),
  stopPrice: "95",
  liquidationPrice: "80",
  leverage: "2",
  maintenanceBracket: 1,
  maintMarginRatio: "0.01",
  cumMaintenance: "0",
};

const ONE_WAY_MODE = { dualSide: false, multiAssets: false, fingerprint: "0".repeat(64) } as const;
const DUAL_MODE = { dualSide: true, multiAssets: false, fingerprint: "0".repeat(64) } as const;

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
  accountMode?: typeof ONE_WAY_MODE | typeof DUAL_MODE | null;
  accountModeReaders?: "available" | "missing" | "incomplete";
  currentDualSide?: boolean;
  currentMultiAssets?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const orders = new InMemoryLiveOrderStore();
  const store = new InMemoryReconciliationStore(options.unsettledIntents);
  const statuses = options.statuses ?? [];
  const localOrders = statuses.map((status, index) => order(status, String(index + 1)));
  for (const local of localOrders) orders.addOrder(local);
  const calls: string[] = [];
  const recovered: string[] = [];
  const accountMode = options.accountMode === null ? undefined : options.accountMode ?? ONE_WAY_MODE;
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
    ...(options.accountModeReaders === "missing" ? {} : {
      positionSide: async () => options.accountModeReaders === "incomplete"
        ? {} as { dualSidePosition: boolean }
        : { dualSidePosition: options.currentDualSide ?? accountMode?.dualSide ?? false },
      multiAssetsMargin: async () => ({
        multiAssetsMargin: options.currentMultiAssets ?? accountMode?.multiAssets ?? false,
      }),
    }),
  };
  const service = new ReconciliationService({
    client,
    orders,
    store,
    accountMode,
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
    expect((await h.store.listIssues()).some((issue) => issue.category === "UNSETTLED_INTENT"
      && issue.symbol === "BTCUSDT")).toBe(true);
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
        positionSide: async () => ({ dualSidePosition: false }),
        multiAssetsMargin: async () => ({ multiAssetsMargin: false }),
      },
      orders,
      store,
      accountMode: ONE_WAY_MODE,
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
        positionSide: async () => ({ dualSidePosition: false }),
        multiAssetsMargin: async () => ({ multiAssetsMargin: false }),
      },
      orders,
      store,
      accountMode: ONE_WAY_MODE,
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
    const shortOrder = { ...order("FILLED"), side: "SHORT" as const, positionSide: "SHORT" as const };
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
    }, { ...seed, side: "SHORT", positionSide: "SHORT" });

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
      exchangeOrderId: "902", type: "STOP_MARKET", entrySemantics: "REDUCE", reduceOnly: true, price: "95", stopPrice: "95",
    });
    const remoteProtection = remoteOrder(order("NEW", "2"), "2");
    Object.assign(remoteProtection, {
      clientOrderId: "protect-intent-1", orderId: 902, type: "STOP_MARKET", reduceOnly: true, side: "SELL",
      stopPrice: "95",
    });
    const service = new ReconciliationService({
      client: {
        account: async () => account(), positionRisk: async () => [position("1")], openOrders: async () => [remoteProtection],
        positionSide: async () => ({ dualSidePosition: false }),
        multiAssetsMargin: async () => ({ multiAssetsMargin: false }),
      },
      orders,
      store,
      accountMode: ONE_WAY_MODE,
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
      client: {
        account: async () => account("999"), positionRisk: async () => [], openOrders: async () => [],
        positionSide: async () => ({ dualSidePosition: false }),
        multiAssetsMargin: async () => ({ multiAssetsMargin: false }),
      },
      orders,
      store,
      accountMode: ONE_WAY_MODE,
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

describe("account compatibility reconciliation", () => {
  function protection(side: "LONG" | "SHORT", quantity: string, stopPrice: string, suffix: string, intentSuffix: string) {
    const local: LiveOrder = {
      ...order("NEW", suffix),
      intentId: `intent-${intentSuffix}`,
      clientOrderId: `protect-intent-${suffix}`,
      side,
      positionSide: side,
      entrySemantics: "REDUCE",
      type: "STOP_MARKET",
      price: stopPrice,
      stopPrice,
      originalQuantity: quantity,
      reduceOnly: true,
    };
    const remote: BinanceOpenOrder = {
      ...remoteOrder(local, suffix),
      side: side === "LONG" ? "SELL" : "BUY",
      positionSide: side,
      reduceOnly: undefined,
    };
    return { local, remote };
  }

  async function addManagedLeg(
    h: Awaited<ReturnType<typeof harness>>,
    side: "LONG" | "SHORT",
    quantity: string,
    suffix: string,
  ) {
    const entry = {
      ...order("FILLED", suffix),
      side,
      positionSide: side,
      originalQuantity: quantity,
    };
    h.orders.addOrder(entry);
    await h.orders.applyFill(entry.id, {
      exchangeTradeId: `trade-${suffix}`,
      exchangeOrderId: entry.exchangeOrderId!,
      symbol: entry.symbol,
      side: side === "LONG" ? "BUY" : "SELL",
      positionSide: side,
      price: "100",
      quantity,
      commission: "0",
      commissionAsset: "USDT",
      realizedPnl: "0",
      isMaker: false,
      executedAt: 100,
    }, {
      ...seed,
      id: entry.intentId,
      side,
      positionSide: side,
      stopPrice: side === "LONG" ? "95" : "105",
    });
  }

  it("reconciles same-symbol LONG and SHORT legs with their own identities and protection", async () => {
    const longProtection = protection("LONG", "1", "95", "3", "1");
    const shortProtection = protection("SHORT", "2", "105", "4", "2");
    const h = await harness({
      accountMode: DUAL_MODE,
      positions: [
        { ...position("1"), positionSide: "LONG" },
        { ...position("-2"), positionSide: "SHORT" },
      ],
      remoteOrders: [longProtection.remote, shortProtection.remote],
    });
    await addManagedLeg(h, "LONG", "1", "1");
    await addManagedLeg(h, "SHORT", "2", "2");
    h.orders.addOrder(longProtection.local);
    h.orders.addOrder(shortProtection.local);

    const result = await h.service.reconcile();

    expect((await h.store.listIssues()).map((issue) => issue.message)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts a legal dual STOP_MARKET without reduceOnly", async () => {
    const stop = protection("LONG", "1", "95", "3", "1");
    const h = await harness({
      accountMode: DUAL_MODE,
      positions: [{ ...position("1"), positionSide: "LONG" }],
      remoteOrders: [stop.remote],
    });
    await addManagedLeg(h, "LONG", "1", "1");
    h.orders.addOrder(stop.local);

    await expect(h.service.reconcile()).resolves.toMatchObject({ ok: true });
  });

  it("rejects a remote position and protection with the wrong positionSide", async () => {
    const stop = protection("LONG", "1", "95", "3", "1");
    stop.remote.reduceOnly = true;
    const h = await harness({
      accountMode: DUAL_MODE,
      positions: [{ ...position("1"), positionSide: "SHORT" }],
      remoteOrders: [{ ...stop.remote, positionSide: "SHORT" }],
    });
    await addManagedLeg(h, "LONG", "1", "1");
    h.orders.addOrder(stop.local);

    const result = await h.service.reconcile();
    const issues = await h.store.listIssues();

    expect(result.ok).toBe(false);
    expect(issues.some((issue) =>
      issue.category === "POSITION_MISMATCH" || issue.category === "UNKNOWN_MANUAL_POSITION"
    )).toBe(true);
    expect(issues.some((issue) => issue.category === "ORDER_MISMATCH"
      && issue.message.includes(stop.local.clientOrderId))).toBe(true);
  });

  it("keeps an opposite-side external position separate from the managed leg", async () => {
    const stop = protection("LONG", "1", "95", "3", "1");
    const h = await harness({
      accountMode: DUAL_MODE,
      positions: [
        { ...position("1"), positionSide: "LONG" },
        { ...position("-3"), positionSide: "SHORT" },
      ],
      remoteOrders: [stop.remote],
    });
    await addManagedLeg(h, "LONG", "1", "1");
    h.orders.addOrder(stop.local);

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).some((issue) => issue.category === "UNKNOWN_MANUAL_POSITION"
      && issue.actualValue === "-3")).toBe(true);
  });

  it("persistently freezes unsettled records when the current account mode changes", async () => {
    const h = await harness({ statuses: ["NEW"], currentDualSide: true });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH")).toBe(true);
    expect(await h.orders.getOrder("client-1")).toMatchObject({ compatibilityFrozen: true });
  });

  it("blocks new entries on an account mode change even when there are no open records", async () => {
    const h = await harness({ currentDualSide: true });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH")).toBe(true);
  });

  it("emits ACCOUNT_MODE_MISMATCH for absent account config with zero open records", async () => {
    const h = await harness({ accountMode: null });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH")).toBe(true);
  });

  it.each([
    { name: "missing", readers: "missing" },
    { name: "incomplete", readers: "incomplete" },
  ] as const)("emits ACCOUNT_MODE_MISMATCH for $name account-mode readers with zero open records", async ({ readers }) => {
    const h = await harness({ accountModeReaders: readers });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect(h.calls).not.toContain("allow");
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH")).toBe(true);
  });

  it("rejects an active order whose fingerprint is undefined", async () => {
    const h = await harness({ statuses: ["NEW"] });
    await h.orders.transitionOrder("client-1", ["NEW"], { accountModeFingerprint: undefined });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH")).toBe(true);
    expect(await h.orders.getOrder("client-1")).toMatchObject({ compatibilityFrozen: true });
  });

  it("does not let a valid position hide a null fingerprint on its active order", async () => {
    const stop = protection("LONG", "1", "95", "3", "1");
    const working = { ...order("NEW", "4"), intentId: "intent-1", accountModeFingerprint: null };
    const h = await harness({
      positions: [{ ...position("1"), positionSide: "LONG" }],
      remoteOrders: [remoteOrder(working, "4"), stop.remote],
      accountMode: DUAL_MODE,
    });
    await addManagedLeg(h, "LONG", "1", "1");
    h.orders.addOrder(working);
    h.orders.addOrder(stop.local);

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH"
      && issue.message.includes("intent-1"))).toBe(true);
    expect(await h.orders.getOrder(working.clientOrderId)).toMatchObject({ compatibilityFrozen: true });
  });

  it("does not apply legacy missing-fingerprint handling to a valid active order listed as unsettled", async () => {
    const h = await harness({
      statuses: ["NEW"],
      unsettledIntents: [{ id: "intent-1", symbol: "BTCUSDT", status: "NEW" }],
    });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(true);
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH")).toBe(false);
    expect((await h.orders.getOrder("client-1"))?.compatibilityFrozen).not.toBe(true);
  });

  it("marks an orphaned legacy unsettled intent as fingerprint-incompatible", async () => {
    const h = await harness({
      unsettledIntents: [{ id: "legacy-orphan", symbol: "BTCUSDT", status: "SUBMITTING" }],
    });

    const result = await h.service.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).map((issue) => issue.category)).toEqual(expect.arrayContaining([
      "UNSETTLED_INTENT",
      "ACCOUNT_MODE_MISMATCH",
    ]));
  });

  it("reports a persisted legacy freeze again after restart instead of resuming it", async () => {
    const h = await harness({ statuses: ["NEW"] });
    await h.orders.transitionOrder("client-1", ["NEW"], { compatibilityFrozen: true });
    const restarted = new ReconciliationService({
      client: {
        account: async () => account(),
        positionRisk: async () => [],
        openOrders: async () => [remoteOrder(order("NEW"))],
        positionSide: async () => ({ dualSidePosition: false }),
        multiAssetsMargin: async () => ({ multiAssetsMargin: false }),
      },
      orders: h.orders,
      store: h.store,
      accountMode: ONE_WAY_MODE,
      recovery: { recover: async () => (await h.orders.getOrder("client-1"))! },
      accounting: { synchronize: async () => undefined },
      pauseNewEntries: async () => null,
    });

    const result = await restarted.reconcile();

    expect(result.ok).toBe(false);
    expect((await h.store.listIssues()).some((issue) => issue.category === "ACCOUNT_MODE_MISMATCH")).toBe(true);
    expect(await h.orders.getOrder("client-1")).toMatchObject({ compatibilityFrozen: true });
  });
});
