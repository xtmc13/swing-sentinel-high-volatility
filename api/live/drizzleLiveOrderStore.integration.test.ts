import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@db/schema";
import { DrizzleLiveOrderStore } from "./drizzleLiveOrderStore";
import { pauseLiveExecution } from "./livePersistence";
import type { LiveFill, LiveOrder, LivePositionSeed } from "./orderStateMachine";

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
    expect(await restarted.getOrder(order.clientOrderId)).toMatchObject({
      status: "FILLED",
      executedQuantity: "3",
      averagePrice: "100.666666666666666666666666666667",
      commission: "0.5",
    });
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
});
