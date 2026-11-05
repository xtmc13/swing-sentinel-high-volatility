import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@db/schema";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import { pauseLiveExecution } from "./livePersistence";
import { OrderStateMachine, type LiveFill, type LiveOrder, type LivePositionSeed } from "./orderStateMachine";
import type { BinanceOpenOrder, BinancePositionRisk, LiveOrderGateway, PlaceOrderRequest } from "./binanceSigned";
import { compareDecimals } from "./decimal";

const testDatabaseUrl = process.env.TASK4_TEST_DATABASE_URL;
const describeDatabase = testDatabaseUrl ? describe : describe.skip;
if (testDatabaseUrl && new URL(testDatabaseUrl).pathname !== "/swing_sentinel_task4_test") {
  throw new Error("Task 4 integration tests require the dedicated swing_sentinel_task4_test database");
}
const db = testDatabaseUrl ? drizzle(testDatabaseUrl, { mode: "planetscale", schema }) : null;

const seed: LivePositionSeed = {
  id: "task4-intent",
  symbol: "BTCUSDT",
  side: "LONG",
  positionSide: "LONG",
  entrySemantics: "ENTRY",
  accountModeFingerprint: "0".repeat(64),
  compatibilityFrozen: false,
  stopPrice: "99",
  liquidationPrice: "50",
  leverage: "5",
  maintenanceBracket: 1,
  maintMarginRatio: "0.01",
  cumMaintenance: "0",
};

const order: LiveOrder = {
  id: "task4-order-row",
  intentId: seed.id,
  clientOrderId: "task4-entry",
  exchangeOrderId: "900",
  symbol: seed.symbol,
  side: seed.side,
  positionSide: seed.positionSide,
  entrySemantics: seed.entrySemantics,
  notionalCap: "50000",
  notionalFloor: "0",
  initialLeverage: 10,
  accountModeFingerprint: seed.accountModeFingerprint,
  compatibilityFrozen: false,
  type: "LIMIT",
  status: "PENDING_SEND",
  price: "100",
  stopPrice: null,
  originalQuantity: "3",
  executedQuantity: "0",
  averagePrice: "0",
  commission: "0",
  reduceOnly: false,
  createdAt: 1_793_600_000_000,
};

function fill(overrides: Partial<LiveFill> = {}): LiveFill {
  return {
    exchangeTradeId: "task4-trade-1",
    exchangeOrderId: "900",
    symbol: seed.symbol,
    side: "BUY",
    price: "100",
    quantity: "1",
    commission: "0.1",
    commissionAsset: "USDT",
    realizedPnl: "0",
    isMaker: false,
    executedAt: 1_793_600_000_100,
    ...overrides,
  };
}

beforeAll(async () => {
  if (!db) return;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../db/migrations", import.meta.url)) });
});

beforeEach(async () => {
  if (!db) return;
  await db.delete(schema.liveFills);
  await db.delete(schema.liveOrders);
  await db.delete(schema.livePositions);
  await db.delete(schema.liveIntents);
  await db.insert(schema.liveIntents).values({
    id: seed.id,
    signalId: seed.id,
    symbol: seed.symbol,
    side: seed.side,
    status: "PENDING_SEND",
    quantity: "3",
    limitPrice: "100",
    stopPrice: "99",
    liquidationPrice: "50",
    leverage: 5,
    notional: "300",
    reservedMargin: "60",
    reservedRisk: "3",
    version: 1,
    expiresAt: new Date(1_893_600_000_000),
  });
});

afterAll(async () => {
  if (db) await db.$client.end();
});

describeDatabase("Task 4 dedicated durable order store", () => {
  it("atomically deduplicates fills and restores exact order/position aggregates after restart", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleLiveOrderStore(db);
    await store.insertOrder(order);
    expect((await store.transitionOrder(order.clientOrderId, ["PENDING_SEND"], { status: "SUBMITTING" }))?.status)
      .toBe("SUBMITTING");

    await store.applyFill(order.id, fill({ price: "102" }), seed);
    await store.applyFill(order.id, fill({
      exchangeTradeId: "task4-trade-2", quantity: "2", commission: "0.4", executedAt: 1_793_600_000_050,
    }), seed);
    await store.applyFill(order.id, fill({
      exchangeTradeId: "task4-trade-2", quantity: "2", commission: "0.4", executedAt: 1_793_600_000_050,
    }), seed);

    const restarted = new DrizzleLiveOrderStore(db);
    const restoredOrder = await restarted.getOrder(order.clientOrderId);
    expect(restoredOrder).toMatchObject({
      status: "FILLED",
      executedQuantity: "3",
      averagePrice: "100.666666666666666666666666666667",
      commission: "0.5",
      initialLeverage: 10,
    });
    expect(compareDecimals(restoredOrder!.notionalCap!, "50000")).toBe(0);
    expect(compareDecimals(restoredOrder!.notionalFloor!, "0")).toBe(0);
    expect(await restarted.getPosition(seed.id)).toMatchObject({
      quantity: "3",
      initialQuantity: "3",
      openedAt: 1_793_600_000_050,
    });
    expect((await db.select().from(schema.liveFills))).toHaveLength(2);
    expect((await db.select().from(schema.liveIntents))[0]?.status).toBe("FILLED");

    const protection: LiveOrder = {
      ...order,
      id: "task4-protection-row",
      clientOrderId: "task4-protection",
      exchangeOrderId: "901",
      type: "STOP_MARKET",
      entrySemantics: "REDUCE",
      status: "PENDING_SEND",
      price: "99",
      stopPrice: "99",
      executedQuantity: "0",
      reduceOnly: true,
    };
    await restarted.insertOrder(protection);
    await restarted.transitionOrder(protection.clientOrderId, ["PENDING_SEND"], { status: "SUBMITTING" });
    await restarted.applyFill(protection.id, fill({
      exchangeTradeId: "task4-close-trade",
      exchangeOrderId: "901",
      side: "SELL",
      quantity: "3",
    }), seed);
    expect((await db.select().from(schema.liveIntents))[0]?.status).toBe("FILLED");
  });

  it("persists signed mark updates and trailing stops without changing the original risk stop", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleLiveOrderStore(db);
    await store.insertOrder(order);
    await store.applyFill(order.id, fill(), seed);

    await store.updatePosition(seed.id, {
      markPrice: "103", liquidationPrice: "49", isolatedWallet: "20.4", stopPrice: "98.5",
    });

    const restarted = new DrizzleLiveOrderStore(db);
    expect(await restarted.getPosition(seed.id)).toMatchObject({
      markPrice: "103", liquidationPrice: "49", isolatedWallet: "20.4",
      stopPrice: "98.5", initialStopPrice: "99",
    });
    expect((await db.select().from(schema.liveIntents))[0]?.stopPrice)
      .toBe("98.500000000000000000000000000000");
  });

  it("cross-worker emergency CANCEL cannot be overwritten by submit admission", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleLiveOrderStore(db);
    await store.insertOrder(order);
    await db.insert(schema.tradingSettings).values({ id: 1, autoTrade: true })
      .onDuplicateKeyUpdate({ set: { autoTrade: true } });
    await db.insert(schema.liveControls).values({ id: 1, emergencyGeneration: 0 })
      .onDuplicateKeyUpdate({ set: { emergencyGeneration: 0 } });
    await pauseLiveExecution(db);

    expect((await db.select().from(schema.liveIntents))[0]?.status).toBe("CANCEL");
    expect(await store.admitOrder(order.clientOrderId, 0, async () => undefined)).toMatchObject({ status: "CANCEL" });
    expect((await db.select().from(schema.liveOrders))[0]?.status).toBe("CANCEL");
  });

  it("allows only one worker to claim PENDING_SEND for submission", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleLiveOrderStore(db);
    await store.insertOrder(order);
    const [first, second] = await Promise.all([
      store.transitionOrder(order.clientOrderId, ["PENDING_SEND"], { status: "SUBMITTING" }),
      store.transitionOrder(order.clientOrderId, ["PENDING_SEND"], { status: "SUBMITTING" }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("persists a compatibility freeze on intent, order, and position across restart", async () => {
    if (!db) throw new Error("database required");
    const store = new DrizzleLiveOrderStore(db);
    await store.insertOrder(order);
    await store.applyFill(order.id, fill(), seed);

    expect(store.freezeCompatibility).toBeTypeOf("function");
    await store.freezeCompatibility([seed.id]);

    const restarted = new DrizzleLiveOrderStore(db);
    expect(await restarted.getOrder(order.clientOrderId)).toMatchObject({ compatibilityFrozen: true });
    expect(await restarted.getPosition(seed.id)).toMatchObject({ compatibilityFrozen: true });
    expect((await db.select().from(schema.liveIntents))[0]?.compatibilityFrozen).toBe(true);
  });

  class DrizzleDualGateway implements LiveOrderGateway {
    readonly placed: PlaceOrderRequest[] = [];
    readonly remote = new Map<string, BinanceOpenOrder>();
    readQuantity: () => string = () => "1.25";
    private nextOrderId = 1000;

    constructor(private readonly store: DrizzleLiveOrderStore, private readonly positionSide: "LONG" | "SHORT") {}

    async positionRisk(): Promise<BinancePositionRisk[]> {
      const quantity = this.readQuantity();
      return [{
        symbol: seed.symbol,
        positionSide: this.positionSide,
        positionAmt: this.positionSide === "SHORT" ? `-${quantity}` : quantity,
        entryPrice: "100",
        markPrice: "100",
        liquidationPrice: "50",
        leverage: "5",
        marginType: "isolated",
        isolatedWallet: "20",
      }];
    }

    async placeOrder(request: PlaceOrderRequest): Promise<BinanceOpenOrder> {
      this.placed.push(request);
      const remote: BinanceOpenOrder = {
        symbol: request.symbol,
        orderId: this.nextOrderId++,
        clientOrderId: request.newClientOrderId!,
        price: request.price ?? "0",
        origQty: request.quantity,
        executedQty: "0",
        status: "NEW",
        side: request.side,
        positionSide: request.positionSide,
        type: request.type,
        reduceOnly: request.reduceOnly,
      };
      this.remote.set(remote.clientOrderId, remote);
      return remote;
    }

    async cancelOrder(request: { symbol: string; origClientOrderId?: string }): Promise<BinanceOpenOrder> {
      const clientOrderId = request.origClientOrderId!;
      const current = this.remote.get(clientOrderId);
      if (!current) throw new Error("remote order missing");
      const local = await this.store.getOrder(clientOrderId);
      const cancelled = { ...current, status: "CANCELED", executedQty: local?.executedQuantity ?? current.executedQty };
      this.remote.set(clientOrderId, cancelled);
      return cancelled;
    }

    async queryOrder(request: { symbol: string; origClientOrderId?: string }): Promise<BinanceOpenOrder | null> {
      return this.remote.get(request.origClientOrderId!) ?? null;
    }

    async userTrades() {
      return [];
    }
  }

  async function dualHarness(side: "LONG" | "SHORT") {
    if (!db) throw new Error("database required");
    const store = new DrizzleLiveOrderStore(db);
    const gateway = new DrizzleDualGateway(store, side);
    const accountMode = { dualSide: true, multiAssets: false, fingerprint: seed.accountModeFingerprint! };
    const machine = new OrderStateMachine(store, gateway, { accountMode });
    const dualSeed: LivePositionSeed = { ...seed, side, positionSide: side };
    const dualOrder: LiveOrder = {
      ...order,
      id: `dual-entry-row-${side}`,
      clientOrderId: `dual-entry-${side}`,
      side,
      positionSide: side,
      accountModeFingerprint: accountMode.fingerprint,
      status: "FILLED",
    };
    await db.update(schema.liveIntents).set({ side, positionSide: side });
    await store.insertOrder(dualOrder);
    await store.applyFill(dualOrder.id, fill({
      side: side === "LONG" ? "BUY" : "SELL",
      positionSide: side,
      quantity: "3",
    }), dualSeed);
    return { store, gateway, machine, dualSeed, dualOrder };
  }

  function pendingReduce(h: Awaited<ReturnType<typeof dualHarness>>, kind: "close" | "protect"): LiveOrder {
    return {
      ...h.dualOrder,
      id: `pending-${kind}-row-${h.dualSeed.side}`,
      clientOrderId: `${kind}-${h.dualSeed.id}`,
      exchangeOrderId: null,
      entrySemantics: "REDUCE",
      type: kind === "close" ? "MARKET" : "STOP_MARKET",
      status: "PENDING_SEND",
      price: kind === "close" ? "0" : "99",
      stopPrice: kind === "close" ? null : "99",
      originalQuantity: "3",
      reduceOnly: true,
    };
  }

  it("compare-and-set requires SUBMITTING, the expected prior quantity, and no exchange order ID", async () => {
    const h = await dualHarness("LONG");
    const pending = pendingReduce(h, "close");
    await h.store.insertOrder(pending);

    expect(await h.store.transitionOrderQuantity(pending.clientOrderId, "3", "1.25")).toBeNull();
    await h.store.transitionOrder(pending.clientOrderId, ["PENDING_SEND"], {
      status: "SUBMITTING", exchangeOrderId: null,
    });
    expect(await h.store.transitionOrderQuantity(pending.clientOrderId, "2", "1.25")).toBeNull();
    const updated = await h.store.transitionOrderQuantity(pending.clientOrderId, "3", "1.25");
    expect(updated).not.toBeNull();
    expect(compareDecimals(updated!.originalQuantity, "1.25")).toBe(0);
    await h.store.transitionOrder(pending.clientOrderId, ["SUBMITTING"], { exchangeOrderId: "1234" });
    expect(await h.store.transitionOrderQuantity(pending.clientOrderId, "1.25", "2")).toBeNull();
  });

  it.each(["LONG", "SHORT"] as const)("persists the fresh quantity for a crash-after-insert pending %s close", async (side) => {
    const h = await dualHarness(side);
    await h.store.insertOrder(pendingReduce(h, "close"));

    const resumed = await h.machine.closePosition(h.dualSeed.id);

    expect(resumed).not.toBeNull();
    expect(compareDecimals(resumed!.originalQuantity, "1.25")).toBe(0);
    expect(compareDecimals(h.gateway.placed.at(-1)!.quantity, "1.25")).toBe(0);
  });

  it.each(["LONG", "SHORT"] as const)("persists the fresh quantity for a pending %s protection restart", async (side) => {
    const h = await dualHarness(side);
    await h.store.insertOrder(pendingReduce(h, "protect"));

    await h.machine.protectPosition(h.dualSeed.id);

    expect(compareDecimals(h.gateway.placed.at(-1)!.quantity, "1.25")).toBe(0);
  });

  it.each(["LONG", "SHORT"] as const)("persists the fresh quantity for a %s STOP replacement", async (side) => {
    const h = await dualHarness(side);
    await h.machine.protectPosition(h.dualSeed.id);
    const active = (await h.store.listOrders()).find((order) => order.intentId === h.dualSeed.id
      && order.type === "STOP_MARKET" && order.status === "NEW")!;

    const replaced = await h.machine.replaceOrder(active.clientOrderId, "98");

    expect(compareDecimals(replaced.originalQuantity, "1.25")).toBe(0);
    expect(compareDecimals(h.gateway.placed.at(-1)!.quantity, "1.25")).toBe(0);
  });

  it.each(["LONG", "SHORT"] as const)("persists a second external reduction before a %s partial-CANCEL retry transport", async (side) => {
    const h = await dualHarness(side);
    const pending = pendingReduce(h, "close");
    await h.store.insertOrder(pending);
    await h.store.applyFill(pending.id, fill({
      exchangeTradeId: `task4-partial-close-${side}`,
      exchangeOrderId: "950",
      side: side === "LONG" ? "SELL" : "BUY",
      positionSide: side,
      quantity: "1",
    }), h.dualSeed);
    await h.store.transitionOrder(pending.clientOrderId, ["PARTIALLY_FILLED"], { status: "CANCEL" });
    let reads = 0;
    h.gateway.readQuantity = () => {
      reads += 1;
      return reads === 1 ? "0.75" : "0.5";
    };

    const retry = await h.machine.closePosition(h.dualSeed.id);

    expect(reads).toBe(2);
    expect(retry).not.toBeNull();
    expect(compareDecimals(retry!.originalQuantity, "0.5")).toBe(0);
    expect(compareDecimals(h.gateway.placed.at(-1)!.quantity, "0.5")).toBe(0);
  });
});
