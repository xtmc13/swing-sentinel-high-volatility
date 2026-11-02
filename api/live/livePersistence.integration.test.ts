import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";
import * as schema from "@db/schema";
import { calculateLivePositionRisk } from "./liveRisk";
import {
  claimLiveIntent,
  createLiveIntent,
  getLiveIntentReservations,
  type CreateLiveIntentInput,
} from "./livePersistence";

const testDatabaseUrl = process.env.TASK3_TEST_DATABASE_URL;
const describeDatabase = testDatabaseUrl ? describe : describe.skip;
if (testDatabaseUrl && new URL(testDatabaseUrl).pathname !== "/swing_sentinel_task3_test") {
  throw new Error("Task 3 integration tests require the dedicated swing_sentinel_task3_test database");
}

const NOW = 1_793_600_000_000;
const PAPER_SENTINEL = "task3-paper-sentinel";
const db = testDatabaseUrl ? drizzle(testDatabaseUrl, { mode: "planetscale", schema }) : null;
const pools: { end(): void | Promise<void> }[] = [];

function independentDb() {
  if (!testDatabaseUrl) throw new Error("TASK3_TEST_DATABASE_URL is required");
  const independent = drizzle(testDatabaseUrl, { mode: "planetscale", schema });
  pools.push(independent.$client);
  return independent;
}

function intentInput(id: string, signalId: string, workerId = "worker-a"): CreateLiveIntentInput {
  return {
    id,
    signalId,
    symbol: "BTCUSDT",
    side: "LONG",
    quantity: "40",
    limitPrice: "100",
    stopPrice: "99",
    liquidationPrice: "50",
    leverage: 5,
    notional: "4000",
    reservedMargin: "800",
    reservedRisk: "60",
    expiresAt: new Date(NOW + 60_000),
    workerId,
    leaseDurationMs: 5_000,
  };
}

beforeAll(async () => {
  if (!testDatabaseUrl || !db) return;
  const client = await mysql.createConnection({ uri: testDatabaseUrl, multipleStatements: true });
  try {
    await client.query(
      `INSERT INTO positions
        (id, symbol, side, status, initial_qty, qty, entry_price, stop_price, target_price,
         liquidation_price, leverage, margin, initial_risk)
       VALUES (?, 'BTCUSDT', 'LONG', 'OPEN', 1, 1, 100, 99, 102, 50, 5, 20, 1)
       ON DUPLICATE KEY UPDATE id = id`,
      [PAPER_SENTINEL],
    );
    await client.query("INSERT INTO trading_settings (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id");
  } finally {
    await client.end();
  }
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../db/migrations", import.meta.url)) });
});

beforeEach(async () => {
  if (!db) return;
  await db.delete(schema.liveFills);
  await db.delete(schema.liveOrders);
  await db.delete(schema.liveIntents);
  await db.delete(schema.livePositions);
  await db.delete(schema.liveAccountSnapshots);
  await db.delete(schema.liveLedgerEntries);
  await db.delete(schema.reconciliationIssues);
});

afterAll(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  if (db) await db.$client.end();
});

describeDatabase("Task 3 独立 MariaDB 持久化", () => {
  it("增量迁移保留 paper 持仓并为真实账本建立 DECIMAL 表", async () => {
    if (!db) throw new Error("database required");
    const paper = await db.select().from(schema.positions).where(eq(schema.positions.id, PAPER_SENTINEL));
    expect(paper[0]).toMatchObject({ status: "OPEN", qty: 1, entryPrice: 100, stopPrice: 99 });

    const columns = await db.execute(sql`
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('live_intents', 'live_orders', 'live_fills', 'live_positions',
          'live_account_snapshots', 'live_ledger_entries', 'reconciliation_issues')
    `);
    const rows = (columns as unknown as [Array<{ TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string }>])[0];
    expect(new Set(rows.map((row) => row.TABLE_NAME))).toEqual(new Set([
      "live_intents", "live_orders", "live_fills", "live_positions",
      "live_account_snapshots", "live_ledger_entries", "reconciliation_issues",
    ]));
    expect(rows.find((row) => row.TABLE_NAME === "live_intents" && row.COLUMN_NAME === "reserved_margin")?.DATA_TYPE)
      .toBe("decimal");
  });

  it("跨独立 worker 连接相同 signalId 只能创建一个意图", async () => {
    const [first, second] = await Promise.all([
      createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "shared-signal", "worker-a"), { now: () => NOW }),
      createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "shared-signal", "worker-b"), { now: () => NOW }),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    if (!db) throw new Error("database required");
    expect(await db.select().from(schema.liveIntents)).toHaveLength(1);
  });

  it("worker lease 到期前拒绝其他 worker，到期后原子接管并递增版本", async () => {
    const id = crypto.randomUUID();
    await createLiveIntent(independentDb(), intentInput(id, "leased-signal"), { now: () => NOW });

    expect(await claimLiveIntent(independentDb(), {
      id, workerId: "worker-b", expectedVersion: 1, leaseDurationMs: 5_000,
    }, { now: () => NOW + 1_000 })).toMatchObject({ ok: false });
    expect(await claimLiveIntent(independentDb(), {
      id, workerId: "worker-b", expectedVersion: 1, leaseDurationMs: 5_000,
    }, { now: () => NOW + 5_001 })).toMatchObject({ ok: true, version: 2 });
    expect(await claimLiveIntent(independentDb(), {
      id, workerId: "worker-b", expectedVersion: 2, leaseDurationMs: 5_000,
    }, { now: () => NOW + 61_000 })).toMatchObject({ ok: false });
  });

  it("持久化待单预留进入真实风险计算", async () => {
    await createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "reserved-signal"), { now: () => NOW });
    if (!db) throw new Error("database required");
    const reservation = await getLiveIntentReservations(db, NOW);
    expect(reservation).toEqual({ margin: "800", risk: "60" });

    const risk = calculateLivePositionRisk({
      side: "LONG",
      walletBalance: "10000",
      availableBalance: "10000",
      entryPrice: "100",
      stopPrice: "99",
      liquidationPrice: "50",
      actualLeverage: "5",
      leverageMode: "FIXED",
      fixedLeverage: 5,
      riskPerTradePct: 1,
      marginPerTradePct: 10,
      totalMarginCapPct: 20,
      takerFeeBps: 0,
      slippageBps: 0,
      stepSize: "0.001",
      minQuantity: "0.001",
      minNotional: "5",
      brackets: [{
        bracket: 1,
        initialLeverage: 10,
        notionalCap: "50000",
        notionalFloor: "0",
        maintMarginRatio: "0.01",
        cum: "0",
      }],
      pendingIntents: [reservation],
    });
    expect(risk).toMatchObject({ ok: true, quantity: "40", reservedMargin: "800", reservedRisk: "60" });
  });

  it("提交前风险复核失败会回滚意图", async () => {
    const id = crypto.randomUUID();
    await expect(createLiveIntent(independentDb(), intentInput(id, "rejected-signal"), {
      now: () => NOW,
      recheckRisk: async () => { throw new Error("risk changed"); },
    })).rejects.toThrow("risk changed");
    if (!db) throw new Error("database required");
    expect(await db.select().from(schema.liveIntents)).toHaveLength(0);
  });

  it("设置锁行缺失时失败关闭而不是无锁写入", async () => {
    if (!db) throw new Error("database required");
    await db.delete(schema.tradingSettings).where(eq(schema.tradingSettings.id, 1));
    try {
      await expect(createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "missing-settings-lock"), {
        now: () => NOW,
      })).rejects.toThrow("Trading settings are missing");
      expect(await db.select().from(schema.liveIntents)).toHaveLength(0);
    } finally {
      await db.insert(schema.tradingSettings).values({ id: 1 });
    }
  });

  it("跨 worker 风险复核与意图写入串行，后提交者能读取先提交者预留", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let secondCallbackEntered = false;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "risk-race-first"), {
      now: () => NOW,
      recheckRisk: async () => {
        markFirstStarted();
        await gate;
      },
    });
    await firstStarted;
    const second = createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "risk-race-second", "worker-b"), {
      now: () => NOW,
      recheckRisk: async (tx) => {
        const reservation = await getLiveIntentReservations(tx, NOW);
        secondCallbackEntered = true;
        if (reservation.margin !== "0") throw new Error("risk changed");
        await secondGate;
      },
    });
    for (let attempt = 0; attempt < 200 && !secondCallbackEntered; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    releaseFirst();
    releaseSecond();
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult.status).toBe("rejected");
    if (!db) throw new Error("database required");
    expect(await db.select().from(schema.liveIntents)).toHaveLength(1);
  });

  it("事务内提交前再次发现信号过期时不写入意图", async () => {
    const id = crypto.randomUUID();
    const times = [NOW, NOW + 61_000];
    const result = await createLiveIntent(independentDb(), intentInput(id, "expires-during-recheck"), {
      now: () => times.shift() ?? NOW + 61_000,
      recheckRisk: async () => undefined,
    });

    expect(result.ok).toBe(false);
    if (!db) throw new Error("database required");
    expect(await db.select().from(schema.liveIntents)).toHaveLength(0);
  });

  it("clientOrderId 与 exchange order/trade/transaction ID 均由数据库拒绝重复", async () => {
    const firstDb = independentDb();
    const intentId = crypto.randomUUID();
    await createLiveIntent(firstDb, intentInput(intentId, "unique-ids"), { now: () => NOW });
    const orderId = crypto.randomUUID();
    await firstDb.insert(schema.liveOrders).values({
      id: orderId,
      intentId,
      clientOrderId: "client-unique",
      exchangeOrderId: "900",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      originalQuantity: "1",
      executedQuantity: "0",
    });
    await expect(firstDb.insert(schema.liveOrders).values({
      id: crypto.randomUUID(), intentId, clientOrderId: "client-unique", symbol: "BTCUSDT", side: "BUY",
      type: "LIMIT", status: "NEW", price: "100", originalQuantity: "1", executedQuantity: "0",
    })).rejects.toMatchObject({ cause: { code: "ER_DUP_ENTRY" } });
    await expect(firstDb.insert(schema.liveOrders).values({
      id: crypto.randomUUID(), intentId, clientOrderId: "client-other", exchangeOrderId: "900",
      symbol: "BTCUSDT", side: "BUY", type: "LIMIT", status: "NEW", price: "100",
      originalQuantity: "1", executedQuantity: "0",
    })).rejects.toMatchObject({ cause: { code: "ER_DUP_ENTRY" } });

    const fill = {
      orderId,
      exchangeTradeId: "trade-unique",
      exchangeOrderId: "900",
      symbol: "BTCUSDT",
      side: "BUY",
      price: "100",
      quantity: "1",
      quoteQuantity: "100",
      commission: "0.01",
      commissionAsset: "USDT",
      realizedPnl: "0",
      isMaker: false,
      executedAt: new Date(NOW),
    };
    await firstDb.insert(schema.liveFills).values({ id: crypto.randomUUID(), ...fill });
    await expect(firstDb.insert(schema.liveFills).values({ id: crypto.randomUUID(), ...fill }))
      .rejects.toMatchObject({ cause: { code: "ER_DUP_ENTRY" } });

    const ledger = {
      exchangeTransactionId: "transaction-unique",
      symbol: "BTCUSDT",
      asset: "USDT",
      entryType: "COMMISSION",
      amount: "-0.01",
      occurredAt: new Date(NOW),
    };
    await firstDb.insert(schema.liveLedgerEntries).values({ id: crypto.randomUUID(), ...ledger });
    await expect(firstDb.insert(schema.liveLedgerEntries).values({ id: crypto.randomUUID(), ...ledger }))
      .rejects.toMatchObject({ cause: { code: "ER_DUP_ENTRY" } });
  });
});
