import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@db/schema";
import { calculateLivePositionRisk } from "./liveRisk";
import { DrizzleLiveDailyRisk } from "./liveDailyRisk";
import { decimal } from "./decimal";
import { getOutstandingOrderCounts } from "../queries/trading";
import {
  assertLiveSubmission,
  claimLiveIntent,
  createLiveIntent,
  disarmLiveExecution,
  getLiveIntentReservations,
  pauseLiveExecution,
  setLiveArmed,
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
const migrationsFolder = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const db = testDatabaseUrl ? drizzle(testDatabaseUrl, { mode: "planetscale", schema }) : null;
const pools: { end(): void | Promise<void> }[] = [];

async function migrateLegacySchema(database: LiveDatabase) {
  const legacyFolder = await mkdtemp(join(tmpdir(), "account-compat-legacy-"));
  try {
    const files = (await readdir(migrationsFolder)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < "0015_");
    await mkdir(join(legacyFolder, "meta"));
    const journal = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx < 15);
    await writeFile(join(legacyFolder, "meta", "_journal.json"), JSON.stringify(journal));
    for (const name of files) await copyFile(join(migrationsFolder, name), join(legacyFolder, name));
    await migrate(database, { migrationsFolder: legacyFolder });
  } finally {
    await rm(legacyFolder, { recursive: true, force: true });
  }
}

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
    expiresAt: new Date(Date.now() + 60_000),
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
    effectiveLeverage: input.leverage,
    marginType: "ISOLATED" as const,
    maintenanceBracket: 1,
    maintMarginRatio: "0.01",
    cumMaintenance: "0",
    liquidationPriceSource: "PRETRADE_ESTIMATE" as const,
    validUntil: input.expiresAt,
    ...overrides,
  });
}

function createApprovedIntent(db: LiveDatabase, input: CreateLiveIntentInput) {
  return createLiveIntent(db, input, { assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input) });
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
  await db.delete(schema.liveDailyRisk);
  await db.delete(schema.reconciliationIssues);
  await db.delete(schema.liveControls);
  await db.insert(schema.liveControls).values({ id: 1, armed: true, emergencyGeneration: 0 });
  await db.update(schema.tradingSettings).set({ executionMode: "LIVE_MAINNET" })
    .where(eq(schema.tradingSettings.id, 1));
  await db.insert(schema.volatilityStates).values({ symbol: "BTCUSDT", mode: "NORMAL", lastDataAt: NOW })
    .onDuplicateKeyUpdate({ set: { mode: "NORMAL" } });
});

afterAll(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  if (db) await db.$client.end();
});

describeDatabase("Task 3 独立 MariaDB 持久化", () => {
  it("0015 完整保存新身份并保守迁移旧 one-way 记录", async () => {
    if (!testDatabaseUrl) throw new Error("database required");
    const serverUrl = new URL(testDatabaseUrl);
    serverUrl.pathname = "";
    const server = await mysql.createConnection({ uri: serverUrl.toString(), multipleStatements: true });
    const migrationUrl = new URL(testDatabaseUrl);
    migrationUrl.pathname = "/swing_sentinel_task3_migration_test";
    let migrationDb: typeof db = null;
    try {
      await server.query("DROP DATABASE IF EXISTS swing_sentinel_task3_migration_test");
      await server.query("CREATE DATABASE swing_sentinel_task3_migration_test");
      migrationDb = drizzle(migrationUrl.toString(), { mode: "planetscale", schema });
      await migrateLegacySchema(migrationDb);
      await migrationDb.execute(sql`
        INSERT INTO trading_settings (id, execution_mode, leverage_mode)
        VALUES (1, 'LIVE_MAINNET', 'SYMBOL_MAX'), (2, 'PAPER', 'SYMBOL_MAX')
      `);
      await migrationDb.execute(sql`
        INSERT INTO live_intents
          (id, signal_id, symbol, side, status, quantity, limit_price, stop_price, liquidation_price,
           leverage, notional, reserved_margin, reserved_risk, expires_at)
        VALUES ('legacy-intent', 'legacy-signal', 'BTCUSDT', 'LONG', 'PENDING_SEND', 2, 100, 99, 50,
          5, 200, 40, 2, '2037-01-01')
      `);
      await migrationDb.execute(sql`
        INSERT INTO live_orders
          (id, intent_id, client_order_id, symbol, side, type, status, price, original_quantity,
           executed_quantity, reduce_only)
        VALUES
          ('legacy-entry', 'legacy-intent', 'legacy-entry-client', 'BTCUSDT', 'LONG', 'LIMIT', 'NEW', 100, 2, 0, false),
          ('legacy-reduce', 'legacy-intent', 'legacy-reduce-client', 'BTCUSDT', 'LONG', 'MARKET', 'NEW', 100, 1, 0, true),
          ('legacy-orphan', 'missing-intent', 'legacy-orphan-client', 'BTCUSDT', 'SHORT', 'LIMIT', 'NEW', 100, 1, 0, false)
      `);
      await migrationDb.execute(sql`
        INSERT INTO live_positions
          (id, symbol, side, status, initial_quantity, quantity, entry_price, mark_price,
           liquidation_price, isolated_wallet, leverage, maintenance_bracket, maint_margin_ratio,
           cum_maintenance, closed_at)
        VALUES
          ('legacy-open', 'BTCUSDT', 'LONG', 'OPEN', 2, 2, 100, 101, 50, 40, 5, 1, 0.01, 0, NULL),
          ('legacy-closed', 'BTCUSDT', 'SHORT', 'CLOSED', 1, 0, 100, 90, 150, 20, 5, 1, 0.01, 0, CURRENT_TIMESTAMP(3))
      `);

      await migrate(migrationDb, { migrationsFolder });
      const migratedSettings = await migrationDb.select().from(schema.tradingSettings);
      expect(migratedSettings.find((row) => row.id === 1)?.leverageMode).toBe("ACCOUNT_CONFIGURED");
      expect(migratedSettings.find((row) => row.id === 2)).toMatchObject({
        executionMode: "PAPER", leverageMode: "SYMBOL_MAX",
      });
      expect((await migrationDb.select().from(schema.liveIntents))[0]).toMatchObject({
        id: "legacy-intent", positionSide: "LONG", marginType: null, entrySemantics: "ENTRY",
        effectiveLeverage: 5, maintenanceBracket: null, maintMarginRatio: null, cumMaintenance: null,
        liquidationPriceSource: "LEGACY_UNKNOWN", accountModeFingerprint: null, compatibilityFrozen: true,
      });
      const legacyOrders = await migrationDb.select().from(schema.liveOrders);
      const legacyOrderFields = {
        marginType: null, maintenanceBracket: null, maintMarginRatio: null, cumMaintenance: null,
        liquidationPriceSource: "LEGACY_UNKNOWN", accountModeFingerprint: null, compatibilityFrozen: true,
      };
      expect(legacyOrders.find((row) => row.id === "legacy-entry")).toMatchObject({
        positionSide: "LONG", entrySemantics: "ENTRY", effectiveLeverage: 5, ...legacyOrderFields,
      });
      expect(legacyOrders.find((row) => row.id === "legacy-reduce")).toMatchObject({
        positionSide: "LONG", entrySemantics: "REDUCE", effectiveLeverage: 5, ...legacyOrderFields,
      });
      expect(legacyOrders.find((row) => row.id === "legacy-orphan")).toMatchObject({
        positionSide: "SHORT", entrySemantics: "ENTRY", effectiveLeverage: null, ...legacyOrderFields,
      });
      const legacyPositions = await migrationDb.select().from(schema.livePositions);
      expect(legacyPositions.find((row) => row.id === "legacy-open")).toMatchObject({
        positionSide: "LONG", marginType: null, entrySemantics: "ENTRY", effectiveLeverage: 5,
        maintenanceBracket: 1, maintMarginRatio: "0.010000000000000000000000000000",
        cumMaintenance: "0.000000000000000000000000000000", liquidationPriceSource: "LEGACY_UNKNOWN",
        accountModeFingerprint: null, compatibilityFrozen: true,
      });
      expect(legacyPositions.find((row) => row.id === "legacy-closed")).toMatchObject({
        positionSide: "SHORT", marginType: null, entrySemantics: "ENTRY", effectiveLeverage: 5,
        maintenanceBracket: 1, maintMarginRatio: "0.010000000000000000000000000000",
        cumMaintenance: "0.000000000000000000000000000000", liquidationPriceSource: "LEGACY_UNKNOWN",
        accountModeFingerprint: null, compatibilityFrozen: false,
      });

      const fingerprint = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      await migrationDb.insert(schema.liveIntents).values({
        id: "new-intent", signalId: "new-signal", symbol: "BTCUSDT", side: "SHORT", status: "PENDING_SEND",
        quantity: "1", limitPrice: "100", stopPrice: "101", liquidationPrice: "150", leverage: 150,
        notional: "100", reservedMargin: "0.666666666666666666666666666667", reservedRisk: "1",
        expiresAt: new Date("2037-01-01T00:00:00Z"), positionSide: "SHORT", marginType: "CROSS",
        entrySemantics: "ENTRY", effectiveLeverage: 150, maintenanceBracket: 2, maintMarginRatio: "0.02",
        cumMaintenance: "10", liquidationPriceSource: "PRETRADE_ESTIMATE", accountModeFingerprint: fingerprint,
        compatibilityFrozen: false,
      });
      await migrationDb.insert(schema.liveOrders).values({
        id: "new-order", intentId: "new-intent", clientOrderId: "new-client", symbol: "BTCUSDT", side: "SHORT",
        type: "MARKET", status: "NEW", price: "100", originalQuantity: "1", executedQuantity: "0",
        positionSide: "SHORT", marginType: "CROSS", entrySemantics: "REDUCE", effectiveLeverage: 150,
        maintenanceBracket: 2, maintMarginRatio: "0.02", cumMaintenance: "10",
        liquidationPriceSource: "EXCHANGE", accountModeFingerprint: fingerprint, compatibilityFrozen: false,
      });
      await migrationDb.insert(schema.livePositions).values({
        id: "new-position", symbol: "BTCUSDT", side: "SHORT", initialQuantity: "1", quantity: "1",
        entryPrice: "100", markPrice: "100", liquidationPrice: "150", isolatedWallet: "1", leverage: "150",
        maintenanceBracket: 2, maintMarginRatio: "0.02", cumMaintenance: "10", positionSide: "SHORT",
        marginType: "CROSS", entrySemantics: "ENTRY", effectiveLeverage: 150,
        liquidationPriceSource: "EXCHANGE", accountModeFingerprint: fingerprint, compatibilityFrozen: false,
      });
      expect(await migrationDb.select().from(schema.liveIntents).where(eq(schema.liveIntents.id, "new-intent")))
        .toMatchObject([{ positionSide: "SHORT", marginType: "CROSS", entrySemantics: "ENTRY",
          effectiveLeverage: 150, maintenanceBracket: 2, maintMarginRatio: "0.020000000000000000000000000000",
          cumMaintenance: "10.000000000000000000000000000000", liquidationPriceSource: "PRETRADE_ESTIMATE",
          accountModeFingerprint: fingerprint, compatibilityFrozen: false }]);
      expect(await migrationDb.select().from(schema.liveOrders).where(eq(schema.liveOrders.id, "new-order")))
        .toMatchObject([{ positionSide: "SHORT", marginType: "CROSS", entrySemantics: "REDUCE",
          effectiveLeverage: 150, maintenanceBracket: 2, maintMarginRatio: "0.020000000000000000000000000000",
          cumMaintenance: "10.000000000000000000000000000000", liquidationPriceSource: "EXCHANGE",
          accountModeFingerprint: fingerprint, compatibilityFrozen: false }]);
      expect(await migrationDb.select().from(schema.livePositions).where(eq(schema.livePositions.id, "new-position")))
        .toMatchObject([{ positionSide: "SHORT", marginType: "CROSS", entrySemantics: "ENTRY",
          effectiveLeverage: 150, maintenanceBracket: 2, maintMarginRatio: "0.020000000000000000000000000000",
          cumMaintenance: "10.000000000000000000000000000000", liquidationPriceSource: "EXCHANGE",
          accountModeFingerprint: fingerprint, compatibilityFrozen: false }]);
    } finally {
      if (migrationDb) await migrationDb.$client.end();
      await server.query("DROP DATABASE IF EXISTS swing_sentinel_task3_migration_test");
      await server.end();
    }
  });

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
      mode: "NORMAL",
      highVolatilityRiskMultiplier: 0.5,
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
      assertCurrentAdmission: async () => undefined, finalGate: async () => { throw new Error("risk changed"); },
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
      assertCurrentAdmission: async () => undefined, finalGate: async () => {
        markFirstStarted();
        await gate;
        return finalGateFor(firstInput)();
      },
    });
    await firstStarted;
    const secondInput = intentInput(crypto.randomUUID(), "risk-race-second", "worker-b");
    const second = createLiveIntent(independentDb(), secondInput, {
      assertCurrentAdmission: async () => undefined, finalGate: async (tx) => {
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
      assertCurrentAdmission: async () => undefined, finalGate: async () => {
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
      assertCurrentAdmission: async () => undefined, finalGate: async () => ({ approved: false as const, reason: "stale risk" }),
    });

    expect(result).toMatchObject({ ok: false, reason: "stale risk" });
  });

  it("只持久化 final gate 批准的数量、名义价值、margin 和 risk", async () => {
    if (!db) throw new Error("database required");
    const input = intentInput(crypto.randomUUID(), "approved-values");
    const result = await createLiveIntent(independentDb(), input, {
      assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input, {
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
    const result = await createLiveIntent(independentDb(), input, { assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input, values) });

    expect(result.ok).toBe(false);
  });

  it("PAPER 模式即使 final gate 批准也拒绝 live 意图", async () => {
    if (!db) throw new Error("database required");
    await db.update(schema.tradingSettings).set({ executionMode: "PAPER" }).where(eq(schema.tradingSettings.id, 1));
    const input = intentInput(crypto.randomUUID(), "paper-mode");

    const result = await createLiveIntent(independentDb(), input, { assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input) });

    expect(result.ok).toBe(false);
    expect(await db.select().from(schema.liveIntents)).toHaveLength(0);
  });

  it("limitPrice 不符合 tickSize 时在 final gate 前拒绝", async () => {
    const input = { ...intentInput(crypto.randomUUID(), "invalid-tick"), limitPrice: "100.005" };
    let gateCalled = false;

    const result = await createLiveIntent(independentDb(), input, {
      assertCurrentAdmission: async () => undefined, finalGate: async () => {
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
      expect((await createLiveIntent(pooled, input, { assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input) })).ok).toBe(true);
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
      assertCurrentAdmission: async () => undefined, finalGate: async () => {
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
    await createLiveIntent(independentDb(), input, { assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input) });

    const claimed = await claimLiveIntent(independentDb(), {
      id: input.id, workerId: "worker-b", expectedVersion: 1, leaseDurationMs: 5_000,
    }, { now: () => Number.MAX_SAFE_INTEGER });

    expect(claimed.ok).toBe(false);
  });

  it("相同 exchange order/trade ID 可存在于不同 symbol，但同 symbol 仍唯一", async () => {
    const firstDb = independentDb();
    const input = intentInput(crypto.randomUUID(), "symbol-scoped-ids");
    await createLiveIntent(firstDb, input, { assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input) });
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
    await createLiveIntent(firstDb, input, { assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input) });
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
      assertCurrentAdmission: async () => undefined, finalGate: finalGateFor(input),
    });
    expect(created).toMatchObject({ ok: true, emergencyGeneration: 0 });
    await assertLiveSubmission(independentDb(), { intentId: input.id, expectedGeneration: 0, assertCurrentAdmission: async () => undefined });

    await pauseLiveExecution(independentDb());
    await expect(assertLiveSubmission(independentDb(), { intentId: input.id, expectedGeneration: 0, assertCurrentAdmission: async () => undefined }))
      .rejects.toThrow("emergency or pause");
    expect((await db.select().from(schema.liveControls))[0]?.emergencyGeneration).toBe(1);
    expect((await db.select().from(schema.liveIntents))[0]?.status).toBe("CANCEL");
    expect((await db.select().from(schema.tradingSettings))[0]?.autoTrade).toBe(false);
  });

  it("arming 网络预检不持有 controls 锁，并发 disarm 获胜且不被旧 arming 覆盖", async () => {
    if (!db) throw new Error("database required");
    let markPreflight!: () => void;
    let releasePreflight!: () => void;
    const entered = new Promise<void>((resolve) => { markPreflight = resolve; });
    const gate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const arming = setLiveArmed(independentDb(), true, async () => {
      markPreflight();
      await gate;
    });
    await entered;
    try {
      const disarmed = await Promise.race([
        disarmLiveExecution(independentDb()).then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(disarmed).toBe(true);
    } finally {
      releasePreflight();
      await arming.catch(() => undefined);
    }
    expect((await db.select().from(schema.liveControls))[0]).toMatchObject({ armed: false });
  });

  it("LIVE 日初权益与日损锁在独立连接重启后保持", async () => {
    if (!db) throw new Error("database required");
    const first = new DrizzleLiveDailyRisk(independentDb());
    await expect(first.evaluate("2027-01-15", 1000, 2)).resolves.toEqual({
      dayStartEquity: 1000, dailyLocked: false,
    });
    await expect(first.evaluate("2027-01-15", 979, 2)).resolves.toEqual({
      dayStartEquity: 1000, dailyLocked: true,
    });

    const restarted = new DrizzleLiveDailyRisk(independentDb());
    await expect(restarted.evaluate("2027-01-15", 990, 2)).resolves.toEqual({
      dayStartEquity: 1000, dailyLocked: true,
    });
    expect(await db.select().from(schema.liveDailyRisk)).toMatchObject([{
      dayKey: "2027-01-15", dayStartEquity: "1000.000000000000000000000000000000", dailyLocked: true,
    }]);
  });

  it("REDUCE 部分成交在独立连接重启后仍按身份减仓且不修改入场 intent 状态", async () => {
    if (!db) throw new Error("database required");
    const { DrizzleLiveOrderStore } = await import("./drizzleLiveOrderStore");
    const database = independentDb();
    const store = new DrizzleLiveOrderStore(database);
    const fingerprint = "1".repeat(64);
    const id = crypto.randomUUID();
    const input = {
      ...intentInput(id, "durable-reduce-identity"), positionSide: "LONG" as const,
      entrySemantics: "ENTRY" as const, accountModeFingerprint: fingerprint,
    };
    await createApprovedIntent(database, input);
    const seed = {
      id, symbol: input.symbol, side: input.side, positionSide: input.positionSide,
      entrySemantics: input.entrySemantics, accountModeFingerprint: fingerprint,
      stopPrice: input.stopPrice, liquidationPrice: input.liquidationPrice, leverage: String(input.leverage),
      maintenanceBracket: 1, maintMarginRatio: "0.01", cumMaintenance: "0",
    };
    await store.insertOrder({
      id: "durable-entry", intentId: id, clientOrderId: "durable-entry", exchangeOrderId: "980",
      symbol: input.symbol, side: input.side, positionSide: "LONG", entrySemantics: "ENTRY",
      accountModeFingerprint: fingerprint, type: "LIMIT", status: "NEW", price: "100", stopPrice: null,
      originalQuantity: "3", executedQuantity: "0", averagePrice: "0", commission: "0",
      reduceOnly: false, createdAt: NOW,
    });
    await store.applyFill("durable-entry", {
      exchangeTradeId: "durable-entry-fill", exchangeOrderId: "980", symbol: input.symbol, side: "BUY",
      positionSide: "LONG", price: "100", quantity: "3", commission: "0.1", commissionAsset: "USDT",
      realizedPnl: "0", isMaker: false, executedAt: NOW,
    }, seed);
    await store.insertOrder({
      id: "durable-close", intentId: id, clientOrderId: "durable-close", exchangeOrderId: "981",
      symbol: input.symbol, side: input.side, positionSide: "LONG", entrySemantics: "REDUCE",
      accountModeFingerprint: fingerprint, type: "MARKET", status: "NEW", price: "0", stopPrice: null,
      originalQuantity: "3", executedQuantity: "0", averagePrice: "0", commission: "0",
      reduceOnly: false, createdAt: NOW + 1,
    });

    await store.applyFill("durable-close", {
      exchangeTradeId: "durable-close-partial", exchangeOrderId: "981", symbol: input.symbol, side: "SELL",
      positionSide: "LONG", price: "101", quantity: "1", commission: "0.1", commissionAsset: "USDT",
      realizedPnl: "1", isMaker: false, executedAt: NOW + 1,
    }, seed);

    const restarted = new DrizzleLiveOrderStore(independentDb());
    expect(await restarted.getPosition(id)).toMatchObject({ status: "OPEN", quantity: "2" });
    expect(await restarted.getOrder("durable-close")).toMatchObject({
      status: "PARTIALLY_FILLED", executedQuantity: "1", entrySemantics: "REDUCE",
    });
    expect((await db.select().from(schema.liveIntents).where(eq(schema.liveIntents.id, id)))[0]?.status).toBe("FILLED");

    await restarted.applyFill("durable-close", {
      exchangeTradeId: "durable-close-final", exchangeOrderId: "981", symbol: input.symbol, side: "SELL",
      positionSide: "LONG", price: "101", quantity: "2", commission: "0.2", commissionAsset: "USDT",
      realizedPnl: "2", isMaker: false, executedAt: NOW + 2,
    }, seed);

    expect(await restarted.getPosition(id)).toMatchObject({ status: "CLOSED", quantity: "0" });
    expect((await db.select().from(schema.liveIntents).where(eq(schema.liveIntents.id, id)))[0]?.status).toBe("FILLED");
  });

  it("独立连接重启按 retry 序号恢复最新 UNKNOWN，而不依赖 DB 返回顺序", async () => {
    if (!db) throw new Error("database required");
    const { DrizzleLiveOrderStore } = await import("./drizzleLiveOrderStore");
    const { OrderStateMachine } = await import("./orderStateMachine");
    const database = independentDb();
    const store = new DrizzleLiveOrderStore(database);
    const fingerprint = "2".repeat(64);
    const id = crypto.randomUUID();
    const input = {
      ...intentInput(id, "durable-close-ordering"), positionSide: "LONG" as const,
      entrySemantics: "ENTRY" as const, accountModeFingerprint: fingerprint,
    };
    await createApprovedIntent(database, input);
    const seed = {
      id, symbol: input.symbol, side: input.side, positionSide: input.positionSide,
      entrySemantics: input.entrySemantics, accountModeFingerprint: fingerprint,
      stopPrice: input.stopPrice, liquidationPrice: input.liquidationPrice, leverage: String(input.leverage),
      maintenanceBracket: 1, maintMarginRatio: "0.01", cumMaintenance: "0",
    };
    await store.insertOrder({
      id: "ordering-entry", intentId: id, clientOrderId: "ordering-entry", exchangeOrderId: "990",
      symbol: input.symbol, side: input.side, positionSide: "LONG", entrySemantics: "ENTRY",
      accountModeFingerprint: fingerprint, type: "LIMIT", status: "NEW", price: "100", stopPrice: null,
      originalQuantity: "2", executedQuantity: "0", averagePrice: "0", commission: "0",
      reduceOnly: false, createdAt: NOW,
    });
    await store.applyFill("ordering-entry", {
      exchangeTradeId: "ordering-entry-fill", exchangeOrderId: "990", symbol: input.symbol, side: "BUY",
      positionSide: "LONG", price: "100", quantity: "2", commission: "0", commissionAsset: "USDT",
      realizedPnl: "0", isMaker: false, executedAt: NOW,
    }, seed);
    for (const close of [
      { rowId: "z-close-base", suffix: "", status: "CANCEL" as const, exchangeOrderId: "991" },
      { rowId: "z-close-retry-1", suffix: "-retry-1", status: "CANCEL" as const, exchangeOrderId: "992" },
      { rowId: "a-close-retry-2", suffix: "-retry-2", status: "UNKNOWN" as const, exchangeOrderId: "993" },
    ]) {
      await store.insertOrder({
        id: close.rowId, intentId: id, clientOrderId: `close-${id}${close.suffix}`,
        exchangeOrderId: close.exchangeOrderId, symbol: input.symbol, side: input.side, positionSide: "LONG",
        entrySemantics: "REDUCE", accountModeFingerprint: fingerprint, type: "MARKET", status: close.status,
        price: "0", stopPrice: null, originalQuantity: "2", executedQuantity: "0", averagePrice: "0",
        commission: "0", reduceOnly: true, createdAt: NOW + 1,
      });
    }
    const restartedStore = new DrizzleLiveOrderStore(independentDb());
    const listOrders = restartedStore.listOrders.bind(restartedStore);
    restartedStore.listOrders = async () => {
      const rows = await listOrders();
      return [...rows.filter((order) => order.clientOrderId === `close-${id}-retry-2`),
        ...rows.filter((order) => order.clientOrderId !== `close-${id}-retry-2`)];
    };
    const queries: string[] = [];
    const placed: string[] = [];
    let positionRiskCalls = 0;
    const machine = new OrderStateMachine(restartedStore, {
      placeOrder: async () => { placed.push("unexpected"); throw new Error("must reuse recovered close"); },
      cancelOrder: async () => { throw new Error("not used"); },
      queryOrder: async (request) => {
        queries.push(request.origClientOrderId ?? "missing");
        return {
          symbol: input.symbol, orderId: 993, clientOrderId: request.origClientOrderId ?? "missing",
          price: "0", origQty: "2", executedQty: "0", status: "NEW", side: "SELL", positionSide: "LONG", type: "MARKET",
        };
      },
      userTrades: async () => [],
      positionRisk: async () => {
        positionRiskCalls += 1;
        return [{ symbol: input.symbol, positionSide: "LONG" as const, positionAmt: "2", entryPrice: "100",
          markPrice: "100", liquidationPrice: "50", leverage: "5", marginType: "isolated", isolatedWallet: "40" }];
      },
    }, { accountMode: { dualSide: true, fingerprint } });

    const recovered = await machine.closePosition(id);

    expect(recovered).toMatchObject({ clientOrderId: `close-${id}-retry-2`, status: "NEW" });
    expect(queries).toEqual([`close-${id}-retry-2`]);
    expect(placed).toHaveLength(0);
    expect(positionRiskCalls).toBe(0);
  });
});
