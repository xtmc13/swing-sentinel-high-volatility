import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, type Candle, type Market, type Opportunity } from "@contracts/trading";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import type { MarketSnapshot, SymbolMeta } from "./binance";
import type { PaperServiceDependencies } from "./paper";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = testDatabaseUrl ? describe : describe.skip;
if (testDatabaseUrl) {
  const allowedTestDatabases = new Set(["/swing_sentinel_task4_test", "/swing_sentinel_task8_test", "/swing_sentinel_final_fix1_test"]);
  if (!allowedTestDatabases.has(new URL(testDatabaseUrl).pathname)) {
    throw new Error("Database integration tests require a dedicated test database");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
}

const NOW = Date.now();
const fullSchema = { ...schema, ...relations };
let connection: typeof import("../queries/connection");
let trading: typeof import("../queries/trading");
let paper: typeof import("./paper");
const pools: { end(): void | Promise<void> }[] = [];

class FakeMarket {
  readonly sourceGeneration = 0;
  stale = false;
  price = 100.05;
  fundingRates: { symbol: string; fundingTime: number; fundingRate: number }[] = [];
  snapshotHook: (() => Promise<void>) | null = null;

  async getMarketSnapshot(symbol: string): Promise<MarketSnapshot> {
    await this.snapshotHook?.();
    return {
      source: "MAINNET",
      symbol,
      bid: this.price - 0.01,
      ask: this.price + 0.01,
      mid: this.price,
      markPrice: this.price,
      spreadBps: 2,
      bookTime: NOW,
      markTime: NOW,
      observedAt: NOW,
      quality: this.stale
        ? { valid: false, reasons: ["盘口陈旧"], bookAgeMs: 5001, markAgeMs: 5001, candleAgeMs: null }
        : { valid: true, reasons: [], bookAgeMs: 0, markAgeMs: 0, candleAgeMs: null },
    };
  }

  async getSymbolMeta(symbol: string): Promise<SymbolMeta> {
    return { symbol, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  }

  async getMarkets(): Promise<Market[]> {
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"].map((symbol) => ({
      symbol,
      baseAsset: symbol.replace("USDT", ""),
      price: 100.05,
      markPrice: 100.05,
      change24h: 0,
      quoteVolume: 1_000_000_000,
      spreadBps: 2,
      fundingRate: 0,
      high24h: 101,
      low24h: 99,
      maxLeverage: 20,
      liquidityScore: 100,
      eligible: true,
      filterReason: "",
    }));
  }

  async getCandles(symbol: string, _interval: string, limit = 61): Promise<Candle[]> {
    return Array.from({ length: limit }, (_, index) => ({
      time: (NOW - (limit - index) * 900_000) / 1000,
      closeTime: NOW - (limit - index) * 900_000,
      open: 100 + index * 0.1,
      high: 100.1 + index * 0.1,
      low: 99.9 + index * 0.1,
      close: 100 + index * 0.1 + (index % 3) * 0.01,
      volume: 1000,
    }));
  }

  async getFundingRates(symbol: string, startTime: number, endTime: number) {
    return this.fundingRates.filter((event) => event.symbol === symbol && event.fundingTime >= startTime && event.fundingTime <= endTime);
  }
}

function independentDb() {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const db = drizzle(testDatabaseUrl, { mode: "planetscale", schema: fullSchema });
  pools.push(db.$client);
  return db;
}

function service(db: ReturnType<typeof independentDb>, market: FakeMarket) {
  return paper.createPaperService({ getDb: () => db, market, now: () => NOW });
}

function opportunity(symbol: string): Opportunity {
  return {
    id: `${symbol}-LONG`,
    symbol,
    side: "LONG",
    status: "READY",
    score: 90,
    regime: "多头共振",
    entry: 100,
    stop: 98,
    target: 104.4,
    stopDistancePct: 2,
    rewardRisk: 2.2,
    leverage: 20,
    marginPct: 10,
    riskPct: 0.35,
    reasons: [],
    signalCloseTime: NOW - 1000,
    stateVersion: 1,
    sourceGeneration: 0,
    atr15: 0.4,
    createdAt: new Date(NOW - 1000).toISOString(),
  };
}

async function seedState(symbol: string) {
  await connection.getDb().insert(schema.volatilityStates).values({
    symbol,
    mode: "NORMAL",
    confirmationCount: 0,
    stableSince: null,
    atrQuantile: 0.5,
    tickSigma: 1,
    spreadRatio: 1,
    lastDataAt: NOW,
    version: 1,
  });
}

beforeAll(async () => {
  connection = await import("../queries/connection");
  trading = await import("../queries/trading");
  paper = await import("./paper");
  await trading.ensureInitialized();
});

beforeEach(async () => {
  const db = connection.getDb();
  await db.delete(schema.executionOrders);
  await db.delete(schema.closedTrades);
  await db.delete(schema.fundingSettlements);
  await db.delete(schema.positions);
  await db.delete(schema.volatilityStates);
  await db.delete(schema.systemEvents);
  await db.update(schema.simulationAccounts).set({
    cash: 100_000,
    realizedPnl: 0,
    dayStartEquity: 100_000,
    dayKey: new Date(NOW).toISOString().slice(0, 10),
    dailyLockDay: null,
  }).where(eq(schema.simulationAccounts.id, 1));
  await trading.saveSettings({
    ...DEFAULT_SETTINGS,
    autoTrade: true,
    leverageMode: "FIXED",
    fixedLeverage: 20,
    marginPerTradePct: 10,
    totalMarginCapPct: 30,
    maxPositions: 4,
    portfolioStopRiskPct: 1,
    correlatedDirectionRiskPct: 1,
  });
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

afterAll(async () => {
  await connection.getDb().$client.end();
});

describeDatabase("Task 4 真实数据库原子执行", () => {
  it("跨独立连接并发开仓不超过组合预算和持仓上限，并保存真实 initialRisk", async () => {
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
    await Promise.all(symbols.map(seedState));
    const results = await Promise.all(symbols.map((symbol) => {
      const db = independentDb();
      return service(db, new FakeMarket()).openPaperPosition(opportunity(symbol));
    }));

    expect(results.filter((result) => result.ok), JSON.stringify(results)).toHaveLength(2);
    const db = connection.getDb();
    const rows = await db.select().from(schema.positions).where(eq(schema.positions.status, "OPEN"));
    const orders = await db.select().from(schema.executionOrders).where(eq(schema.executionOrders.purpose, "OPEN"));
    expect(rows).toHaveLength(2);
    expect(orders).toHaveLength(2);
    expect(rows.length).toBeLessThanOrEqual(4);
    for (const row of rows) {
      expect(row.initialRisk).toBeCloseTo(Math.abs(row.entryPrice - row.stopPrice), 10);
      expect(row.initialRisk).toBeGreaterThan(0);
    }
  });

  it("跨独立连接重复平仓只有一笔 CLOSE、一笔 closedTrade 和一次账户结算", async () => {
    await seedState("BTCUSDT");
    const opener = service(independentDb(), new FakeMarket());
    const opened = await opener.openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = connection.getDb();
    const beforeRows = await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1));
    const before = beforeRows[0];
    const services = [opener, service(independentDb(), new FakeMarket()), service(independentDb(), new FakeMarket())];
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => services[index % services.length].closePaperPosition(opened.positionId, "并发测试")));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const closeOrders = await db.select().from(schema.executionOrders).where(and(eq(schema.executionOrders.positionId, opened.positionId), eq(schema.executionOrders.purpose, "CLOSE")));
    const trades = await db.select().from(schema.closedTrades).where(eq(schema.closedTrades.symbol, "BTCUSDT"));
    const positionRows = await db.select().from(schema.positions).where(eq(schema.positions.id, opened.positionId));
    const accountRows = await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1));
    expect(closeOrders).toHaveLength(1);
    expect(trades).toHaveLength(1);
    expect(positionRows[0].status).toBe("CLOSED");
    expect(trades[0].fees).toBeCloseTo(positionRows[0].fees + closeOrders[0].fee, 10);
    expect(accountRows[0].cash).toBeCloseTo(before.cash + trades[0].pnl + positionRows[0].fees, 8);
    expect(accountRows[0].realizedPnl).toBeCloseTo(before.realizedPnl + trades[0].pnl + positionRows[0].fees, 8);
  });

  it("生产 closePaperPosition 遇独立连接抢先关闭时零行回滚且不结算", async () => {
    await seedState("BTCUSDT");
    const opened = await service(independentDb(), new FakeMarket()).openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = connection.getDb();
    const before = (await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1)))[0];
    const racingDb = independentDb();
    const racingService = paper.createPaperService({
      getDb: () => racingDb,
      market: new FakeMarket(),
      now: () => NOW,
      beforeCloseUpdate: async (positionId) => {
        await independentDb().update(schema.positions).set({ status: "CLOSED" })
          .where(and(eq(schema.positions.id, positionId), eq(schema.positions.status, "OPEN")));
      },
    });

    await expect(racingService.closePaperPosition(opened.positionId, "生产零行回滚测试")).rejects.toThrow(/0 rows/);
    expect(await db.select().from(schema.executionOrders).where(eq(schema.executionOrders.purpose, "CLOSE"))).toHaveLength(0);
    expect(await db.select().from(schema.closedTrades)).toHaveLength(0);
    const after = (await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1)))[0];
    expect(after.cash).toBe(before.cash);
    expect(after.realizedPnl).toBe(before.realizedPnl);
  });

  it("紧急停止遇到陈旧盘口保持持仓并明确报告未结算项", async () => {
    await seedState("BTCUSDT");
    const market = new FakeMarket();
    const opened = await service(independentDb(), market).openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    market.stale = true;

    const result = await service(independentDb(), market).emergencyStop();

    expect(result.paused).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.unsettled).toHaveLength(1);
    expect(result.unsettled[0]).toMatchObject({ positionId: opened.positionId, symbol: "BTCUSDT" });
    const db = connection.getDb();
    expect((await db.select().from(schema.positions).where(eq(schema.positions.id, opened.positionId)))[0].status).toBe("OPEN");
    expect(await db.select().from(schema.executionOrders).where(eq(schema.executionOrders.purpose, "CLOSE"))).toHaveLength(0);
    expect(await db.select().from(schema.closedTrades)).toHaveLength(0);
    expect((await trading.getSettings()).autoTrade).toBe(false);
  });

  it("紧急暂停与开仓准入串行，成功停止后不能有在途开仓落地", async () => {
    await seedState("BTCUSDT");
    const market = new FakeMarket();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    market.snapshotHook = async () => {
      markStarted();
      await gate;
    };
    const opening = service(independentDb(), market).openPaperPosition(opportunity("BTCUSDT"));
    await started;

    const stopped = await service(independentDb(), new FakeMarket()).emergencyStop();
    release();
    const opened = await opening;

    expect(stopped).toMatchObject({ ok: true, paused: true, settled: [], unsettled: [] });
    expect(opened.ok).toBe(false);
    const db = connection.getDb();
    expect(await db.select().from(schema.positions)).toHaveLength(0);
    expect(await db.select().from(schema.executionOrders)).toHaveLength(0);
    expect((await trading.getSettings()).autoTrade).toBe(false);
  });

  it("开仓网络预取不持有账户锁，强制平仓可独立结算", async () => {
    await Promise.all([seedState("BTCUSDT"), seedState("ETHUSDT")]);
    const opened = await service(independentDb(), new FakeMarket()).openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const blockedMarket = new FakeMarket();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    blockedMarket.snapshotHook = async () => {
      markStarted();
      await gate;
    };
    const opening = service(independentDb(), blockedMarket).openPaperPosition(opportunity("ETHUSDT"));
    await started;
    const closing = service(independentDb(), new FakeMarket()).closePaperPosition(opened.positionId, "锁范围测试");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: string;
    try {
      outcome = await Promise.race([
        closing.then(() => "CLOSED"),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("TIMEOUT"), 1000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
    await Promise.all([opening, closing]);

    expect(outcome).toBe("CLOSED");
    expect((await closing).ok).toBe(true);
  });

  it("结算后的 addEvent 故障不改变紧急停止的已结算结论", async () => {
    await seedState("BTCUSDT");
    const opened = await service(independentDb(), new FakeMarket()).openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = connection.getDb();
    await db.execute(sql`RENAME TABLE system_events TO system_events_failed`);
    let stopped;
    try {
      stopped = await service(independentDb(), new FakeMarket()).emergencyStop();
    } finally {
      await db.execute(sql`RENAME TABLE system_events_failed TO system_events`);
    }

    expect(stopped.ok).toBe(true);
    expect(stopped.settled).toEqual([opened.positionId]);
    expect(stopped.unsettled).toEqual([]);
    expect((await db.select().from(schema.positions).where(eq(schema.positions.id, opened.positionId)))[0].status).toBe("CLOSED");
    expect(await db.select().from(schema.closedTrades)).toHaveLength(1);
  });

  it("紧急平仓发现另一 worker 已 CLOSED 时归为已结算", async () => {
    await seedState("BTCUSDT");
    const opened = await service(independentDb(), new FakeMarket()).openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const emergencyMarket = new FakeMarket();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    emergencyMarket.snapshotHook = async () => {
      markStarted();
      await gate;
    };
    const stopping = service(independentDb(), emergencyMarket).emergencyStop();
    await started;
    const otherClose = await service(independentDb(), new FakeMarket()).closePaperPosition(opened.positionId, "其他 worker");
    release();
    const stopped = await stopping;

    expect(otherClose.ok).toBe(true);
    expect(stopped).toMatchObject({ ok: true, settled: [opened.positionId], unsettled: [] });
    const db = connection.getDb();
    expect(await db.select().from(schema.closedTrades)).toHaveLength(1);
    expect(await db.select().from(schema.executionOrders).where(eq(schema.executionOrders.purpose, "CLOSE"))).toHaveLength(1);
  });

  it("组合预算充足时跨连接并发开仓仍受 maxPositions=1 约束", async () => {
    await trading.saveSettings({
      ...(await trading.getSettings()),
      maxPositions: 1,
      portfolioStopRiskPct: 100,
      correlatedDirectionRiskPct: 100,
    });
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
    await Promise.all(symbols.map(seedState));
    const results = await Promise.all(symbols.map((symbol) => (
      service(independentDb(), new FakeMarket()).openPaperPosition(opportunity(symbol))
    )));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await connection.getDb().select().from(schema.positions).where(eq(schema.positions.status, "OPEN"))).toHaveLength(1);
  });

  it("迁移将 entry==stop 的旧零风险回填为正数且不伪装恢复原风险", async () => {
    const db = connection.getDb();
    const zeroId = crypto.randomUUID();
    const normalId = crypto.randomUUID();
    for (const [id, stopPrice] of [[zeroId, 100], [normalId, 98]] as const) {
      await db.insert(schema.positions).values({
        id,
        symbol: "LEGACY",
        side: "LONG",
        initialQty: 1,
        qty: 1,
        entryPrice: 100,
        stopPrice,
        targetPrice: 100,
        liquidationPrice: 90,
        leverage: 10,
        margin: 10,
        initialRisk: 0,
      });
    }
    if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const migration = await readFile(new URL("../../db/migrations/0001_high_volatility.sql", import.meta.url), "utf8");
    const client = await mysql.createConnection({ uri: testDatabaseUrl, multipleStatements: true });
    try {
      for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }

    const rows = await db.select().from(schema.positions);
    expect(rows.find((row) => row.id === zeroId)?.initialRisk).toBeGreaterThan(0);
    expect(rows.find((row) => row.id === normalId)?.initialRisk).toBe(2);
  });

  it("重置遇陈旧平仓价格时保持未结算持仓与现金，且不报告成功", async () => {
    await seedState("BTCUSDT");
    const market = new FakeMarket();
    const opened = await service(independentDb(), market).openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    market.stale = true;
    const db = connection.getDb();
    const before = (await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1)))[0];
    const resetter = service(independentDb(), market) as ReturnType<typeof service> & {
      resetPaperSimulation?: () => Promise<{ ok: boolean; paused: boolean; unsettled: { positionId: string }[] }>;
    };

    expect(resetter.resetPaperSimulation).toBeTypeOf("function");
    const result = await resetter.resetPaperSimulation!();

    expect(result).toMatchObject({ ok: false, paused: true });
    expect(result.unsettled).toHaveLength(1);
    expect((await db.select().from(schema.positions).where(eq(schema.positions.id, opened.positionId)))[0].status).toBe("OPEN");
    expect((await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1)))[0].cash).toBe(before.cash);
    expect(await db.select().from(schema.closedTrades)).toHaveLength(0);
    expect((await trading.getSettings()).autoTrade).toBe(false);
  });

  it("重置暂停准入后在最终账户锁内确认无 OPEN，在途开仓不能落到已重置账本", async () => {
    await seedState("BTCUSDT");
    const blockedMarket = new FakeMarket();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    blockedMarket.snapshotHook = async () => {
      markStarted();
      await gate;
    };
    const opening = service(independentDb(), blockedMarket).openPaperPosition(opportunity("BTCUSDT"));
    await started;
    const resetter = service(independentDb(), new FakeMarket()) as ReturnType<typeof service> & {
      resetPaperSimulation?: () => Promise<{ ok: boolean; paused: boolean; unsettled: unknown[] }>;
    };

    expect(resetter.resetPaperSimulation).toBeTypeOf("function");
    const resetting = resetter.resetPaperSimulation!();
    for (let attempt = 0; attempt < 100 && (await trading.getSettings()).autoTrade; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect((await trading.getSettings()).autoTrade).toBe(false);
    release();
    const [opened, reset] = await Promise.all([opening, resetting]);

    expect(opened.ok).toBe(false);
    expect(reset).toMatchObject({ ok: true, paused: true, unsettled: [] });
    const db = connection.getDb();
    expect(await db.select().from(schema.positions).where(eq(schema.positions.status, "OPEN"))).toHaveLength(0);
    expect(await db.select().from(schema.executionOrders).where(eq(schema.executionOrders.purpose, "OPEN"))).toHaveLength(0);
    expect((await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1)))[0].cash).toBe(100_000);
    expect((await trading.getSettings()).autoTrade).toBe(false);
  });

  it("独立连接在审批期间转为 EXTREME 时，锁定读取拒绝新开仓", async () => {
    await seedState("BTCUSDT");
    const racingDb = independentDb();
    const dependencies: PaperServiceDependencies & { beforeVolatilityStateLock?: () => Promise<void> } = {
      getDb: () => racingDb,
      market: new FakeMarket(),
      now: () => NOW,
      beforeVolatilityStateLock: async () => {
        await independentDb().update(schema.volatilityStates).set({ mode: "EXTREME", version: 2 })
          .where(eq(schema.volatilityStates.symbol, "BTCUSDT"));
      },
    };

    const result = await paper.createPaperService(dependencies).openPaperPosition(opportunity("BTCUSDT"));

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/EXTREME|状态版本陈旧/);
    expect(await connection.getDb().select().from(schema.positions)).toHaveLength(0);
    expect(await connection.getDb().select().from(schema.executionOrders)).toHaveLength(0);
  });

  it("持仓管理在 UTC 午夜先滚动日初权益，不用昨日亏损触发新日强平", async () => {
    const db = connection.getDb();
    const positionId = crypto.randomUUID();
    await db.insert(schema.positions).values({
      id: positionId,
      symbol: "BTCUSDT",
      side: "LONG",
      initialQty: 1,
      qty: 1,
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104.4,
      liquidationPrice: 90,
      leverage: 20,
      margin: 5,
      initialRisk: 2,
    });
    await db.update(schema.simulationAccounts).set({
      cash: 99_000,
      dayStartEquity: 100_000,
      dayKey: new Date(NOW - 86_400_000).toISOString().slice(0, 10),
    }).where(eq(schema.simulationAccounts.id, 1));
    await trading.saveSettings({ ...(await trading.getSettings()), dailyLossLimitPct: 0.5 });

    await service(independentDb(), new FakeMarket()).manageOpenPositions();

    const position = (await db.select().from(schema.positions).where(eq(schema.positions.id, positionId)))[0];
    const account = (await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1)))[0];
    expect(position.status).toBe("OPEN");
    expect(account.dayKey).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(account.dayStartEquity).toBeCloseTo(99_000.05, 10);
    expect(await db.select().from(schema.closedTrades)).toHaveLength(0);
  });

  it("资金费跨服务重启只结算一次并计入平仓净盈亏", async () => {
    await seedState("BTCUSDT");
    const db = independentDb();
    const market = new FakeMarket();
    const runner = service(db, market);
    const opened = await runner.openPaperPosition(opportunity("BTCUSDT"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await db.update(schema.positions).set({ openedAt: new Date(NOW - 10_000) }).where(eq(schema.positions.id, opened.positionId));
    market.fundingRates = [{ symbol: "BTCUSDT", fundingTime: NOW - 1_000, fundingRate: 0.01 }];
    await runner.manageOpenPositions();
    await service(db, market).manageOpenPositions();
    const position = (await db.select().from(schema.positions).where(eq(schema.positions.id, opened.positionId)))[0];
    const expectedFunding = -position.qty * 100.05 * 0.01;
    expect(position.fundingPnl).toBeCloseTo(expectedFunding, 10);
    expect(await db.select().from(schema.fundingSettlements)).toHaveLength(1);
    const closed = await runner.closePaperPosition(opened.positionId);
    expect(closed.ok).toBe(true);
    const trade = (await db.select().from(schema.closedTrades).where(eq(schema.closedTrades.symbol, "BTCUSDT")))[0];
    const account = (await db.select().from(schema.simulationAccounts).where(eq(schema.simulationAccounts.id, 1)))[0];
    expect(trade.fundingPnl).toBeCloseTo(expectedFunding, 10);
    expect(trade.pnl).toBeCloseTo(account.realizedPnl, 10);
  });

  it("当日锁存存在时即使账面恢复也拒绝新开仓", async () => {
    await seedState("BTCUSDT");
    const db = independentDb();
    await db.update(schema.simulationAccounts).set({
      cash: 100_000, dayStartEquity: 100_000,
      dailyLockDay: new Date(NOW).toISOString().slice(0, 10),
    }).where(eq(schema.simulationAccounts.id, 1));
    const result = await service(db, new FakeMarket()).openPaperPosition(opportunity("BTCUSDT"));
    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain("锁定至下一 UTC 日");
  });

  it("0003 升级迁移把高波动版之前已存在的 auto_trade=true 行暂停", async () => {
    const db = connection.getDb();
    await db.update(schema.tradingSettings).set({ autoTrade: true }).where(eq(schema.tradingSettings.id, 1));
    if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const migration = await readFile(new URL("../../db/migrations/0003_pause_existing_auto_trade.sql", import.meta.url), "utf8");
    const client = await mysql.createConnection({ uri: testDatabaseUrl, multipleStatements: true });
    try {
      for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }

    expect((await trading.getSettings()).autoTrade).toBe(false);
  });
});
