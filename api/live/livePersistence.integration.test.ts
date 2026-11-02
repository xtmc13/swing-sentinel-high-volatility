import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";
import * as schema from "@db/schema";
import { calculateLivePositionRisk } from "./liveRisk";
import { decimal } from "./decimal";
import { getOutstandingOrderCounts } from "../queries/trading";
import {
  assertLiveSubmission,
  claimLiveIntent,
  createLiveIntent,
  getLiveIntentReservations,
  pauseLiveExecution,
  type CreateLiveIntentInput,
  type LiveDatabase,
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
    tickSize: "0.01",
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

function finalGateFor(input: CreateLiveIntentInput, overrides: Record<string, unknown> = {}) {
  return async () => ({
    approved: true as const,
    signalId: input.signalId,
    quantity: input.quantity,
    notional: input.notional,
    reservedMargin: input.reservedMargin,
    reservedRisk: input.reservedRisk,
    validUntil: input.expiresAt,
    ...overrides,
  });
}

function createApprovedIntent(db: LiveDatabase, input: CreateLiveIntentInput) {
  return createLiveIntent(db, input, { finalGate: finalGateFor(input) });
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
  await db.update(schema.tradingSettings).set({ executionMode: "LIVE_MAINNET" })
    .where(eq(schema.tradingSettings.id, 1));
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
      createApprovedIntent(independentDb(), intentInput(crypto.randomUUID(), "shared-signal", "worker-a")),
      createApprovedIntent(independentDb(), intentInput(crypto.randomUUID(), "shared-signal", "worker-b")),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    if (!db) throw new Error("database required");
    expect(await db.select().from(schema.liveIntents)).toHaveLength(1);
  });

  it("worker lease 到期前拒绝其他 worker，到期后原子接管并递增版本", async () => {
    const id = crypto.randomUUID();
    await createApprovedIntent(independentDb(), intentInput(id, "leased-signal"));
    if (!db) throw new Error("database required");

    expect(await claimLiveIntent(independentDb(), {
      id, workerId: "worker-b", expectedVersion: 1, leaseDurationMs: 5_000,
    })).toMatchObject({ ok: false });
    await db.execute(sql`UPDATE live_intents
      SET lease_expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ${id}`);
    expect(await claimLiveIntent(independentDb(), {
      id, workerId: "worker-b", expectedVersion: 1, leaseDurationMs: 5_000,
    })).toMatchObject({ ok: true, version: 2 });
    await db.execute(sql`UPDATE live_intents
      SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ${id}`);
    expect(await claimLiveIntent(independentDb(), {
      id, workerId: "worker-b", expectedVersion: 2, leaseDurationMs: 5_000,
    })).toMatchObject({ ok: false });
  });

  it("持久化待单预留进入真实风险计算", async () => {
    await createApprovedIntent(independentDb(), intentInput(crypto.randomUUID(), "reserved-signal"));
    if (!db) throw new Error("database required");
    const reservation = await getLiveIntentReservations(db);
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
      existingPositionMargin: "0",
      existingExposure: "0",
    });
    expect(risk).toMatchObject({ ok: true, quantity: "40", reservedMargin: "800", reservedRisk: "60" });
  });

  it("提交前风险复核失败会回滚意图", async () => {
    const id = crypto.randomUUID();
    await expect(createLiveIntent(independentDb(), intentInput(id, "rejected-signal"), {
      finalGate: async () => { throw new Error("risk changed"); },
    })).rejects.toThrow("risk changed");
    if (!db) throw new Error("database required");
    expect(await db.select().from(schema.liveIntents)).toHaveLength(0);
  });

  it("设置锁行缺失时失败关闭而不是无锁写入", async () => {
    if (!db) throw new Error("database required");
    await db.delete(schema.tradingSettings).where(eq(schema.tradingSettings.id, 1));
    try {
      await expect(createApprovedIntent(
        independentDb(),
        intentInput(crypto.randomUUID(), "missing-settings-lock"),
      )).rejects.toThrow("Trading settings are missing");
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
    const firstInput = intentInput(crypto.randomUUID(), "risk-race-first");
    const first = createLiveIntent(independentDb(), firstInput, {
      finalGate: async () => {
        markFirstStarted();
        await gate;
        return finalGateFor(firstInput)();
      },
    });
    await firstStarted;
    const secondInput = intentInput(crypto.randomUUID(), "risk-race-second", "worker-b");
    const second = createLiveIntent(independentDb(), secondInput, {
      finalGate: async (tx) => {
        const reservation = await getLiveIntentReservations(tx);
        secondCallbackEntered = true;
        if (reservation.margin !== "0") throw new Error("risk changed");
        await secondGate;
        return finalGateFor(secondInput)();
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
    const input = {
      ...intentInput(crypto.randomUUID(), "expires-during-recheck"),
      expiresAt: new Date(Date.now() + 40),
    };
    const result = await createLiveIntent(independentDb(), input, {
      finalGate: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        return finalGateFor(input, { validUntil: new Date(Date.now() + 60_000) })();
      },
    });

    expect(result.ok).toBe(false);
    if (!db) throw new Error("database required");
    expect(await db.select().from(schema.liveIntents)).toHaveLength(0);
  });

  it("缺少 final gate 时拒绝创建", async () => {
    const result = await createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "missing-final-gate"), {} as never);

    expect(result.ok).toBe(false);
  });

  it("final gate 显式拒绝时不写入意图", async () => {
    const result = await createLiveIntent(independentDb(), intentInput(crypto.randomUUID(), "rejected-final-gate"), {
      finalGate: async () => ({ approved: false as const, reason: "stale risk" }),
    });

    expect(result).toMatchObject({ ok: false, reason: "stale risk" });
  });

  it("只持久化 final gate 批准的数量、名义价值、margin 和 risk", async () => {
    if (!db) throw new Error("database required");
    const input = intentInput(crypto.randomUUID(), "approved-values");
    const result = await createLiveIntent(independentDb(), input, {
      finalGate: finalGateFor(input, {
        quantity: "12.345",
        notional: "1234.5",
        reservedMargin: "246.9",
        reservedRisk: "7",
      }),
    });

    expect(result.ok).toBe(true);
    const row = (await db.select().from(schema.liveIntents))[0];
    expect({
      quantity: decimal(row.quantity),
      notional: decimal(row.notional),
      reservedMargin: decimal(row.reservedMargin),
      reservedRisk: decimal(row.reservedRisk),
    }).toEqual({ quantity: "12.345", notional: "1234.5", reservedMargin: "246.9", reservedRisk: "7" });
  });

  it.each([
    { name: "wrong signal", values: { signalId: "other-signal" } },
    { name: "inconsistent notional", values: { notional: "1" } },
    { name: "inconsistent margin", values: { reservedMargin: "1" } },
    { name: "incoherent notional margin and zero risk", values: { notional: "1", reservedMargin: "0.2", reservedRisk: "0" } },
    { name: "coherent margin with mismatched quantity notional", values: { notional: "1", reservedMargin: "0.2" } },
    { name: "zero opening risk", values: { reservedRisk: "0" } },
    { name: "stale approval", values: { validUntil: new Date(0) } },
  ])("拒绝 $name 的 final gate 结果", async ({ values }) => {
    const input = intentInput(crypto.randomUUID(), "invalid-approval");
    const result = await createLiveIntent(independentDb(), input, { finalGate: finalGateFor(input, values) });

    expect(result.ok).toBe(false);
  });

  it("PAPER 模式即使 final gate 批准也拒绝 live 意图", async () => {
    if (!db) throw new Error("database required");
    await db.update(schema.tradingSettings).set({ executionMode: "PAPER" }).where(eq(schema.tradingSettings.id, 1));
    const input = intentInput(crypto.randomUUID(), "paper-mode");

    const result = await createLiveIntent(independentDb(), input, { finalGate: finalGateFor(input) });

    expect(result.ok).toBe(false);
    expect(await db.select().from(schema.liveIntents)).toHaveLength(0);
  });

  it("limitPrice 不符合 tickSize 时在 final gate 前拒绝", async () => {
    const input = { ...intentInput(crypto.randomUUID(), "invalid-tick"), limitPrice: "100.005" };
    let gateCalled = false;

    const result = await createLiveIntent(independentDb(), input, {
      finalGate: async () => {
        gateCalled = true;
        return finalGateFor(input)();
      },
    });

    expect(result.ok).toBe(false);
    expect(gateCalled).toBe(false);
  });

  it("pooled 非 UTC session 不被修改且过期预留由 DB 时间过滤", async () => {
    if (!testDatabaseUrl) throw new Error("database required");
    const pool = mysql.createPool({ uri: testDatabaseUrl, connectionLimit: 1 });
    const pooled = drizzle(pool, { mode: "planetscale", schema });
    try {
      await pooled.execute(sql`SET SESSION time_zone = '+08:00'`);
      const input = {
        ...intentInput(crypto.randomUUID(), "pool-timezone"),
        expiresAt: new Date(Date.now() + 60_000),
      };
      expect((await createLiveIntent(pooled, input, { finalGate: finalGateFor(input) })).ok).toBe(true);
      expect(await getLiveIntentReservations(pooled)).toEqual({ margin: "800", risk: "60" });

      const timezone = await pooled.execute(sql`SELECT @@session.time_zone AS time_zone`);
      const timezoneRows = (timezone as unknown as [Array<{ time_zone: string }>])[0];
      expect(timezoneRows[0]?.time_zone).toBe("+08:00");

      await pooled.update(schema.liveIntents).set({
        expiresAt: sql`DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)`,
      }).where(eq(schema.liveIntents.id, input.id));
      expect(await getLiveIntentReservations(pooled)).toEqual({ margin: "0", risk: "0" });
      const finalTimezone = await pooled.execute(sql`SELECT @@session.time_zone AS time_zone`);
      const finalTimezoneRows = (finalTimezone as unknown as [Array<{ time_zone: string }>])[0];
      expect(finalTimezoneRows[0]?.time_zone).toBe("+08:00");
    } finally {
      await pool.end();
    }
  });

  it("final gate 延迟超过 lease 时长时仍在复核后以 DB 时间开始 lease", async () => {
    if (!db) throw new Error("database required");
    const input = { ...intentInput(crypto.randomUUID(), "delayed-gate"), leaseDurationMs: 30 };
    let gateFinished = false;

    const result = await createLiveIntent(independentDb(), input, {
      finalGate: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        gateFinished = true;
        return finalGateFor(input)();
      },
    });

    expect(result.ok).toBe(true);
    expect(gateFinished).toBe(true);
    const row = (await db.select().from(schema.liveIntents))[0];
    expect(row.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(row.createdAt.getTime());
    expect(row.leaseExpiresAt!.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(30);
  });

  it("worker 时钟快进到未来也不能提前接管有效 DB lease", async () => {
    const input = intentInput(crypto.randomUUID(), "clock-skew");
    await createLiveIntent(independentDb(), input, { finalGate: finalGateFor(input) });

    const claimed = await claimLiveIntent(independentDb(), {
      id: input.id, workerId: "worker-b", expectedVersion: 1, leaseDurationMs: 5_000,
    }, { now: () => Number.MAX_SAFE_INTEGER });

    expect(claimed.ok).toBe(false);
  });

  it("相同 exchange order/trade ID 可存在于不同 symbol，但同 symbol 仍唯一", async () => {
    const firstDb = independentDb();
    const input = intentInput(crypto.randomUUID(), "symbol-scoped-ids");
    await createLiveIntent(firstDb, input, { finalGate: finalGateFor(input) });
    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      const orderId = crypto.randomUUID();
      await firstDb.insert(schema.liveOrders).values({
        id: orderId,
        intentId: input.id,
        clientOrderId: `client-${symbol}`,
        exchangeOrderId: "shared-exchange-order",
        symbol,
        side: "BUY",
        type: "LIMIT",
        status: "NEW",
        price: "100",
        originalQuantity: "1",
        executedQuantity: "0",
      });
      await firstDb.insert(schema.liveFills).values({
        id: crypto.randomUUID(),
        orderId,
        exchangeTradeId: "shared-exchange-trade",
        exchangeOrderId: "shared-exchange-order",
        symbol,
        side: "BUY",
        price: "100",
        quantity: "1",
        quoteQuantity: "100",
        commission: "0.01",
        commissionAsset: "USDT",
        realizedPnl: "0",
        isMaker: false,
        executedAt: new Date(NOW),
      });
    }
  });

  it("真实 DB 的切换风险计数包含 live intents 和 orders", async () => {
    const firstDb = independentDb();
    const input = intentInput(crypto.randomUUID(), "live-switch-count");
    await createLiveIntent(firstDb, input, { finalGate: finalGateFor(input) });
    await firstDb.insert(schema.liveOrders).values({
      id: crypto.randomUUID(),
      intentId: input.id,
      clientOrderId: "live-switch-order",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: "100",
      originalQuantity: "1",
      executedQuantity: "0",
    });

    expect(await getOutstandingOrderCounts(firstDb)).toEqual({ pendingIntents: 1, unfinishedOrders: 1 });
  });

  it("clientOrderId 与 exchange order/trade/transaction ID 均由数据库拒绝重复", async () => {
    const firstDb = independentDb();
    const intentId = crypto.randomUUID();
    await createApprovedIntent(firstDb, intentInput(intentId, "unique-ids"));
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

  it("open generation 在提交前复核，emergency 递增世代并取消未提交意图", async () => {
    if (!db) throw new Error("database required");
    await db.insert(schema.liveControls).values({ id: 1, emergencyGeneration: 0 })
      .onDuplicateKeyUpdate({ set: { emergencyGeneration: 0 } });
    await db.update(schema.tradingSettings).set({ autoTrade: true }).where(eq(schema.tradingSettings.id, 1));
    const input = intentInput(crypto.randomUUID(), "emergency-generation");
    const created = await createLiveIntent(independentDb(), input, {
      requireAutoTrade: true,
      finalGate: finalGateFor(input),
    });
    expect(created).toMatchObject({ ok: true, emergencyGeneration: 0 });
    await assertLiveSubmission(independentDb(), { intentId: input.id, expectedGeneration: 0 });

    await pauseLiveExecution(independentDb());
    await expect(assertLiveSubmission(independentDb(), { intentId: input.id, expectedGeneration: 0 }))
      .rejects.toThrow("emergency or pause");
    expect((await db.select().from(schema.liveControls))[0]?.emergencyGeneration).toBe(1);
    expect((await db.select().from(schema.liveIntents))[0]?.status).toBe("CANCEL");
    expect((await db.select().from(schema.tradingSettings))[0]?.autoTrade).toBe(false);
  });
});
