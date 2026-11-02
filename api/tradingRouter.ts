import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { adminQuery, isFreshAdminSecret } from "./admin";
import { env } from "./lib/env";
import { engine } from "./services/engine";
import { binance } from "./services/binance";
import {
  getSettings, getAccount, saveSettings, getRecentTrades,
  getRecentOrders, getRecentEvents, getEquityHistory,
} from "./queries/trading";
import {
  toTradeView, calculatePerformance, resetPaperSimulation,
} from "./services/paper";
import { executionCoordinator } from "./services/executionCoordinator";
import { getDb } from "./queries/connection";
import { backtestRuns } from "@db/schema";
import type { DashboardData } from "@contracts/trading";
import { runPortfolioBacktest } from "./services/portfolioBacktest";
import { portfolioRisk } from "./services/risk";
import { startValidationJob, getValidationJob } from "./services/validationJobs";
import { getValidationReport, listValidationReports } from "./queries/validation";

export const settingsInput = z.object({
  strategyMode: z.enum(["SWING", "MOMENTUM", "BOTH"]).optional(),
  momentumEnabled: z.boolean().optional(),
  autoTrade: z.boolean(),
  riskPerTradePct: z.number().min(0.05).max(2),
  marginPerTradePct: z.number().min(0.1).max(10),
  maxPositions: z.number().int().min(1).max(10),
  totalMarginCapPct: z.number().min(1).max(30),
  dailyLossLimitPct: z.number().min(0.5).max(10),
  leverageMode: z.enum(["SYMBOL_MAX", "FIXED"]),
  fixedLeverage: z.number().int().min(1).max(125),
  takerFeeBps: z.number().min(0).max(20),
  slippageBps: z.number().min(0).max(30),
  minQuoteVolume: z.number().min(0),
  maxSpreadBps: z.number().min(0.1).max(100),
  atrBaselineDays: z.number().int().min(1).max(30),
  atrBaselineMinSamples: z.number().int().min(2016).max(100000),
  atrHighPercentile: z.number().min(50).max(100),
  atrExtremePercentile: z.number().min(50).max(100),
  tickHighSigma: z.number().positive().max(20),
  tickExtremeSigma: z.number().positive().max(20),
  minTickVolatility: z.number().min(0).max(1),
  highVolatilityConfirmations: z.number().int().min(1).max(10),
  stableRecoverySeconds: z.number().int().min(1).max(3600),
  normalScanIntervalSeconds: z.number().int().min(5).max(3600),
  highRiskCheckIntervalSeconds: z.number().int().min(1).max(300),
  highVolatilityRiskMultiplier: z.number().positive().max(1),
  portfolioStopRiskPct: z.number().positive().max(10),
  correlatedDirectionRiskPct: z.number().positive().max(10),
  correlationThreshold: z.number().min(0).max(1),
  correlationWindow: z.number().int().min(20).max(500),
  maxSignalAgeSeconds: z.number().int().min(1).max(300),
  bookStaleSeconds: z.number().int().min(1).max(60),
  candleStaleSeconds: z.number().int().min(1).max(600),
  spreadBaselineMinSamples: z.number().int().min(120).max(10000),
  universeSize: z.number().int().min(2).max(150),
});

async function dashboard(): Promise<DashboardData> {
  if (!engine.markets.length) {
    try { await engine.refreshMarkets(); } catch { /* the dashboard remains available in degraded mode */ }
  }
  const [tradeRows, orderRows, eventRows, equityRows, execution, initialAccount] = await Promise.all([
    getRecentTrades(), getRecentOrders(),
    getRecentEvents(), getEquityHistory(), executionCoordinator.dashboard(), getAccount(),
  ]);
  const { account, positions, settings } = execution;
  const observability = engine.getDashboardObservability();
  const currentPortfolioRisk = portfolioRisk({
    equity: account.equity,
    positions,
    takerFeeBps: settings.takerFeeBps,
    slippageBps: settings.slippageBps,
    portfolioStopRiskPct: settings.portfolioStopRiskPct,
    correlatedDirectionRiskPct: settings.correlatedDirectionRiskPct,
    correlationThreshold: settings.correlationThreshold,
  });
  return {
    source: binance.dataSource,
    sourceLabel: binance.sourceLabel,
    connected: binance.isConnected,
    engineState: await engine.engineState(account),
    lastScanAt: engine.lastScanAt,
    account,
    settings,
    markets: engine.markets.slice(0, 60),
    opportunities: engine.opportunities,
    positions,
    trades: tradeRows.map(toTradeView),
    orders: orderRows.map((row) => ({
      id: row.id, positionId: row.positionId, symbol: row.symbol,
      side: row.side === "LONG" ? "LONG" : "SHORT", purpose: row.purpose,
      qty: row.qty, price: row.price, fee: row.fee, status: row.status,
      createdAt: row.createdAt.toISOString(),
    })),
    events: eventRows.map((row) => ({
      id: row.id, level: row.level === "ERROR" ? "ERROR" : row.level === "WARN" ? "WARN" : row.level === "SUCCESS" ? "SUCCESS" : "INFO",
      category: row.category, symbol: row.symbol, message: row.message, createdAt: row.createdAt.toISOString(),
    })),
    metrics: calculatePerformance(tradeRows, initialAccount.initialBalance),
    equityCurve: equityRows.map((row) => ({ time: row.createdAt.toISOString(), equity: row.equity })),
    volatilityStates: observability.states,
    marketQuality: observability.quality,
    portfolioRisk: {
      totalRisk: currentPortfolioRisk.totalRisk,
      totalRiskPct: currentPortfolioRisk.totalRiskPct,
      totalLimit: currentPortfolioRisk.totalLimit,
      remainingTotalRisk: currentPortfolioRisk.remainingTotalRisk,
      correlatedLimit: currentPortfolioRisk.correlatedLimit,
      positions: currentPortfolioRisk.positions,
    },
    monitor: observability.monitor,
    execution: execution.status,
    liveOrders: execution.orders,
    unsettledIntents: execution.unsettledIntents,
    reconciliationIssues: execution.reconciliationIssues,
  };
}

export const tradingRouter = createRouter({
  dashboard: publicQuery.query(dashboard),
  adminStatus: adminQuery.query(() => ({ ok: true as const })),
  setExecutionMode: adminQuery.input(z.object({ executionMode: z.enum(["PAPER", "LIVE_MAINNET"]) }))
    .mutation(({ input }) => executionCoordinator.switchExecutionMode(input.executionMode)),
  setLiveControls: adminQuery.input(z.object({
    armed: z.boolean(),
    confirmationPhrase: z.string().max(64).optional(),
    adminSecret: z.string().max(512).optional(),
  })).mutation(async ({ input }) => {
    if (input.armed) {
      if (!isFreshAdminSecret(input.adminSecret ?? "", env.appSecret)) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "armed 需要重新输入正确的管理员令牌" });
      }
      if (input.confirmationPhrase !== "ARM LIVE MAINNET") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "请输入确认短语 ARM LIVE MAINNET" });
      }
    }
    try {
      return await executionCoordinator.setArmed(input.armed);
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: error instanceof Error ? error.message : "主网控制门控未通过",
      });
    }
  }),
  candles: publicQuery.input(z.object({
    symbol: z.string().regex(/^[A-Z0-9]{5,20}$/),
    interval: z.enum(["5m", "15m", "1h", "4h"]),
  })).query(({ input }) => binance.getCandles(input.symbol, input.interval, 300)),
  scan: adminQuery.mutation(() => engine.scan(true)),
  saveSettings: adminQuery.input(settingsInput).mutation(async ({ input }) => {
    const settings = await getSettings();
    await saveSettings({ ...settings, ...input });
    return dashboard();
  }),
  setAutoTrade: adminQuery.input(z.object({ enabled: z.boolean() })).mutation(async ({ input }) => {
    const settings = await getSettings();
    await saveSettings({ ...settings, autoTrade: input.enabled });
    return { enabled: input.enabled };
  }),
  closePosition: adminQuery.input(z.object({ positionId: z.string().uuid() })).mutation(({ input }) => executionCoordinator.close(input.positionId)),
  emergencyStop: adminQuery.mutation(() => executionCoordinator.emergency()),
  reset: adminQuery.mutation(async () => {
    if ((await getSettings()).executionMode === "LIVE_MAINNET") throw new Error("LIVE_MAINNET 禁止 paper reset");
    return resetPaperSimulation();
  }),
  runBacktest: adminQuery.input(z.object({
    symbol: z.string().regex(/^[A-Z0-9]{5,20}$/),
    timeframe: z.enum(["5m", "15m"]),
    bars: z.number().int().min(300).max(1000),
  })).mutation(({ input }) => runPortfolioBacktest([input.symbol], input.timeframe, input.bars)),
  runPortfolioBacktest: adminQuery.input(z.object({
    symbols: z.array(z.string().regex(/^[A-Z0-9]{5,20}$/)).min(1).max(10).refine((symbols) => new Set(symbols).size === symbols.length, "合约不得重复"),
    timeframe: z.enum(["5m", "15m"]),
    bars: z.number().int().min(300).max(1000),
  })).mutation(({ input }) => runPortfolioBacktest(input.symbols, input.timeframe, input.bars)),
  backtests: publicQuery.query(async () => {
    const rows = await getDb().select().from(backtestRuns).orderBy(desc(backtestRuns.createdAt)).limit(10);
    return rows.map((row) => JSON.parse(row.resultJson));
  }),
  deleteBacktest: adminQuery.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    await getDb().delete(backtestRuns).where(eq(backtestRuns.id, input.id));
    return { ok: true };
  }),
  startValidation: adminQuery.input(z.object({
    symbols: z.array(z.string().regex(/^[A-Z0-9]{5,20}$/)).min(1).max(5)
      .refine((symbols) => new Set(symbols).size === symbols.length, "合约不得重复"),
    timeframe: z.enum(["5m", "15m"]),
    bars: z.number().int().min(900).max(10_000),
  })).mutation(({ input }) => startValidationJob(input.symbols, input.timeframe, input.bars)),
  validationJob: publicQuery.input(z.object({ id: z.string().uuid() })).query(({ input }) => getValidationJob(input.id)),
  validationReports: publicQuery.query(() => listValidationReports()),
  validationReport: publicQuery.input(z.object({ id: z.string().uuid() })).query(({ input }) => getValidationReport(input.id)),
});
