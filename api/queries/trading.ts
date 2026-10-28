import { desc, eq } from "drizzle-orm";
import { getDb } from "./connection";
import {
  simulationAccounts,
  tradingSettings,
  positions,
  closedTrades,
  executionOrders,
  systemEvents,
  equitySnapshots,
} from "@db/schema";
import { DEFAULT_SETTINGS, type TradingSettings } from "@contracts/trading";

export function assertAffectedRows(result: unknown, expected = 1): void {
  const header = Array.isArray(result) ? result[0] : result;
  const affectedRows = Number((header as { affectedRows?: number } | null)?.affectedRows ?? 0);
  if (affectedRows !== expected) {
    throw new Error(`Conditional update affected ${affectedRows} rows; expected ${expected}; transaction rolled back`);
  }
}

export async function ensureInitialized() {
  const db = getDb();
  const account = await db.select().from(simulationAccounts).where(eq(simulationAccounts.id, 1)).limit(1);
  if (!account.length) {
    await db.insert(simulationAccounts).values({ id: 1, dayKey: new Date().toISOString().slice(0, 10) }).onDuplicateKeyUpdate({ set: { id: 1 } });
  }
  const settings = await db.select().from(tradingSettings).where(eq(tradingSettings.id, 1)).limit(1);
  if (!settings.length) {
    await db.insert(tradingSettings).values({ id: 1, ...DEFAULT_SETTINGS }).onDuplicateKeyUpdate({ set: { id: 1 } });
  }
}

export async function getAccount() {
  await ensureInitialized();
  const rows = await getDb().select().from(simulationAccounts).where(eq(simulationAccounts.id, 1)).limit(1);
  return rows[0];
}

export function settingsFromRow(row: typeof tradingSettings.$inferSelect): TradingSettings {
  return {
    autoTrade: row.autoTrade,
    riskPerTradePct: row.riskPerTradePct,
    marginPerTradePct: row.marginPerTradePct,
    maxPositions: row.maxPositions,
    totalMarginCapPct: row.totalMarginCapPct,
    dailyLossLimitPct: row.dailyLossLimitPct,
    leverageMode: row.leverageMode === "FIXED" ? "FIXED" : "SYMBOL_MAX",
    fixedLeverage: row.fixedLeverage,
    takerFeeBps: row.takerFeeBps,
    slippageBps: row.slippageBps,
    minQuoteVolume: row.minQuoteVolume,
    maxSpreadBps: row.maxSpreadBps,
    atrBaselineDays: row.atrBaselineDays,
    atrBaselineMinSamples: row.atrBaselineMinSamples,
    atrHighPercentile: row.atrHighPercentile,
    atrExtremePercentile: row.atrExtremePercentile,
    tickHighSigma: row.tickHighSigma,
    tickExtremeSigma: row.tickExtremeSigma,
    minTickVolatility: row.minTickVolatility,
    highVolatilityConfirmations: row.highVolatilityConfirmations,
    stableRecoverySeconds: row.stableRecoverySeconds,
    normalScanIntervalSeconds: row.normalScanIntervalSeconds,
    highRiskCheckIntervalSeconds: row.highRiskCheckIntervalSeconds,
    highVolatilityRiskMultiplier: row.highVolatilityRiskMultiplier,
    portfolioStopRiskPct: row.portfolioStopRiskPct,
    correlatedDirectionRiskPct: row.correlatedDirectionRiskPct,
    correlationThreshold: row.correlationThreshold,
    correlationWindow: row.correlationWindow,
    maxSignalAgeSeconds: row.maxSignalAgeSeconds,
    bookStaleSeconds: row.bookStaleSeconds,
    candleStaleSeconds: row.candleStaleSeconds,
    spreadBaselineMinSamples: row.spreadBaselineMinSamples,
    universeSize: row.universeSize,
  };
}

export async function getSettings(): Promise<TradingSettings> {
  await ensureInitialized();
  const rows = await getDb().select().from(tradingSettings).where(eq(tradingSettings.id, 1)).limit(1);
  return settingsFromRow(rows[0]);
}

export async function saveSettings(input: TradingSettings) {
  await ensureInitialized();
  await getDb().update(tradingSettings).set({
    autoTrade: input.autoTrade,
    riskPerTradePct: input.riskPerTradePct,
    marginPerTradePct: input.marginPerTradePct,
    maxPositions: input.maxPositions,
    totalMarginCapPct: input.totalMarginCapPct,
    dailyLossLimitPct: input.dailyLossLimitPct,
    leverageMode: input.leverageMode,
    fixedLeverage: input.fixedLeverage,
    takerFeeBps: input.takerFeeBps,
    slippageBps: input.slippageBps,
    minQuoteVolume: input.minQuoteVolume,
    maxSpreadBps: input.maxSpreadBps,
    atrBaselineDays: input.atrBaselineDays,
    atrBaselineMinSamples: input.atrBaselineMinSamples,
    atrHighPercentile: input.atrHighPercentile,
    atrExtremePercentile: input.atrExtremePercentile,
    tickHighSigma: input.tickHighSigma,
    tickExtremeSigma: input.tickExtremeSigma,
    minTickVolatility: input.minTickVolatility,
    highVolatilityConfirmations: input.highVolatilityConfirmations,
    stableRecoverySeconds: input.stableRecoverySeconds,
    normalScanIntervalSeconds: input.normalScanIntervalSeconds,
    highRiskCheckIntervalSeconds: input.highRiskCheckIntervalSeconds,
    highVolatilityRiskMultiplier: input.highVolatilityRiskMultiplier,
    portfolioStopRiskPct: input.portfolioStopRiskPct,
    correlatedDirectionRiskPct: input.correlatedDirectionRiskPct,
    correlationThreshold: input.correlationThreshold,
    correlationWindow: input.correlationWindow,
    maxSignalAgeSeconds: input.maxSignalAgeSeconds,
    bookStaleSeconds: input.bookStaleSeconds,
    candleStaleSeconds: input.candleStaleSeconds,
    spreadBaselineMinSamples: input.spreadBaselineMinSamples,
    universeSize: input.universeSize,
  }).where(eq(tradingSettings.id, 1));
}

export async function getOpenPositions() {
  return getDb().select().from(positions).where(eq(positions.status, "OPEN")).orderBy(desc(positions.openedAt));
}

export async function addEvent(level: "INFO" | "WARN" | "ERROR" | "SUCCESS", category: string, message: string, symbol?: string) {
  await getDb().insert(systemEvents).values({ level, category, message, symbol: symbol ?? null });
}

export async function getRecentTrades(limit = 60) {
  return getDb().select().from(closedTrades).orderBy(desc(closedTrades.closedAt)).limit(limit);
}

export async function getRecentOrders(limit = 60) {
  return getDb().select().from(executionOrders).orderBy(desc(executionOrders.createdAt)).limit(limit);
}

export async function getRecentEvents(limit = 40) {
  return getDb().select().from(systemEvents).orderBy(desc(systemEvents.id)).limit(limit);
}

export async function getEquityHistory(limit = 120) {
  const rows = await getDb().select().from(equitySnapshots).orderBy(desc(equitySnapshots.id)).limit(limit);
  return rows.reverse();
}

