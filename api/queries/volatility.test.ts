import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_SETTINGS, type VolatilityState } from "@contracts/trading";
import { positions, tradingSettings } from "@db/schema";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = testDatabaseUrl ? describe : describe.skip;
if (testDatabaseUrl) {
  const database = new URL(testDatabaseUrl).pathname;
  const allowedTestDatabases = new Set(["/swing_sentinel_task1_test", "/swing_sentinel_task4_test", "/swing_sentinel_task8_test", "/swing_sentinel_final_fix1_test"]);
  if (!allowedTestDatabases.has(database)) {
    throw new Error("Tests require a dedicated test database");
  }
  process.env.DATABASE_URL = testDatabaseUrl;
}

let connection: typeof import("./connection");
let trading: typeof import("./trading");
let volatility: typeof import("./volatility");

beforeAll(async () => {
  connection = await import("./connection");
  trading = await import("./trading");
  volatility = await import("./volatility");
});

afterAll(async () => {
  await connection.getDb().$client.end();
});

describeDatabase("高波动数据契约", () => {
  it("新初始化设置默认暂停自动交易", async () => {
    await connection.getDb().delete(tradingSettings).where(eq(tradingSettings.id, 1));

    expect((await trading.getSettings()).autoTrade).toBe(false);
  });

  it("持久化全部高波动与组合风险设置", async () => {
    const expected = {
      ...DEFAULT_SETTINGS,
      atrBaselineDays: 8,
      atrBaselineMinSamples: 2304,
      atrHighPercentile: 91,
      atrExtremePercentile: 98,
      tickHighSigma: 3.2,
      tickExtremeSigma: 5.2,
      minTickVolatility: 0.0002,
      highVolatilityConfirmations: 3,
      stableRecoverySeconds: 240,
      normalScanIntervalSeconds: 50,
      highRiskCheckIntervalSeconds: 12,
      highVolatilityRiskMultiplier: 0.4,
      portfolioStopRiskPct: 1.2,
      correlatedDirectionRiskPct: 0.6,
      correlationThreshold: 0.75,
      correlationWindow: 80,
      maxSignalAgeSeconds: 20,
      bookStaleSeconds: 6,
      candleStaleSeconds: 100,
      spreadBaselineMinSamples: 150,
      universeSize: 150,
    };

    await trading.saveSettings(expected);

    expect(await trading.getSettings()).toEqual(expected);
  });

  it("保存并读取完整波动状态，重复保存更新同一合约", async () => {
    const state: VolatilityState = {
      symbol: "TASK1TEST",
      mode: "HIGH",
      confirmationCount: 2,
      stableSince: 1_793_000_000_000,
      metrics: { atrQuantile: 0.93, tickSigma: 3.4, spreadRatio: 2.1 },
      lastDataAt: 1_793_000_001_000,
      version: 7,
    };

    await volatility.saveVolatilityState(state);
    expect(await volatility.getVolatilityState(state.symbol)).toEqual(state);

    const changed: VolatilityState = {
      ...state,
      mode: "EXTREME",
      confirmationCount: 0,
      stableSince: null,
      metrics: { atrQuantile: 0.995, tickSigma: 5.6, spreadRatio: 4.2 },
      lastDataAt: 1_793_000_002_000,
      version: 8,
    };
    await volatility.saveVolatilityState(changed);
    expect(await volatility.getVolatilityState(state.symbol)).toEqual(changed);
  });

  it("没有状态的合约返回 null", async () => {
    expect(await volatility.getVolatilityState("TASK1MISSING")).toBeNull();
  });

  it("持仓持久化非空 initialRisk", async () => {
    const id = crypto.randomUUID();
    const db = connection.getDb();
    await db.insert(positions).values({
      id,
      symbol: "TASK1TEST",
      side: "LONG",
      initialQty: 2,
      qty: 2,
      entryPrice: 100,
      stopPrice: 97,
      targetPrice: 106.6,
      liquidationPrice: 90,
      leverage: 10,
      margin: 20,
      initialRisk: 3,
    });

    const rows = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
    expect(rows[0]?.initialRisk).toBe(3);
  });

  it("设置输入接受 2–150 个合约并拒绝范围外数值", async () => {
    const { settingsInput } = await import("../tradingRouter");
    expect(settingsInput.safeParse({ ...DEFAULT_SETTINGS, universeSize: 2 }).success).toBe(true);
    expect(settingsInput.safeParse({ ...DEFAULT_SETTINGS, universeSize: 150 }).success).toBe(true);
    expect(settingsInput.safeParse({ ...DEFAULT_SETTINGS, universeSize: 1 }).success).toBe(false);
    expect(settingsInput.safeParse({ ...DEFAULT_SETTINGS, universeSize: 151 }).success).toBe(false);
  });
});
