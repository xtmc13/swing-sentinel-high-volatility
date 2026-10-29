import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Candle, type Market, type Opportunity, type Side } from "@contracts/trading";
import type { PortfolioSymbolData } from "./portfolioBacktest";
import type { AnalyzeClosedCandlesInput } from "./strategy";
import { runValidationReport } from "./validation";

const START = Date.UTC(2026, 0, 1);
const bars = Array.from({ length: 30 }, (_, index): Candle => {
  const time = START + index * 900_000;
  const close = 100 + index;
  return { time: time / 1000, closeTime: time + 899_999, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1_000_000 };
});
const market: Market = {
  symbol: "BTCUSDT", baseAsset: "BTC", price: 100, markPrice: 100, change24h: 0,
  quoteVolume: 100_000_000, spreadBps: 1, fundingRate: 0, high24h: 110, low24h: 90,
  maxLeverage: 10, liquidityScore: 100, eligible: true, filterReason: "测试",
};
const symbolData: PortfolioSymbolData = {
  symbol: "BTCUSDT",
  market,
  meta: { symbol: "BTCUSDT", tickSize: 0.01, stepSize: 0, minQty: 0, minNotional: 0 },
  candles: { "4h": [], "1h": [], "15m": bars, "5m": bars },
  volatility: bars.map((bar) => ({
    time: bar.closeTime,
    quality: { valid: true, reasons: [], bookAgeMs: 0, markAgeMs: 0, candleAgeMs: 0 },
    currentAtr: 1,
    atrBaseline: [0.5, 1, 1.5],
    currentTickReturn: 0,
    tickReturnBaseline: [-0.001, 0.001],
    currentSpreadBps: 1,
    spreadBaselineBps: [1, 1],
  })),
  funding: [],
};
const settings = {
  ...DEFAULT_SETTINGS,
  riskPerTradePct: 1,
  marginPerTradePct: 10,
  totalMarginCapPct: 100,
  leverageMode: "FIXED" as const,
  fixedLeverage: 10,
  takerFeeBps: 0,
  slippageBps: 0,
  minQuoteVolume: 0,
  atrBaselineMinSamples: 3,
  spreadBaselineMinSamples: 2,
  correlationWindow: 4,
};
const signalTimes = new Set([bars[3].closeTime, bars[20].closeTime, bars[25].closeTime]);
function analyze(input: AnalyzeClosedCandlesInput): Opportunity {
  const ready = signalTimes.has(input.now);
  const side: Side = "LONG";
  return {
    id: `BTCUSDT-${side}`, symbol: "BTCUSDT", side,
    status: ready ? "READY" : "BLOCKED", score: ready ? 100 : 0, regime: "测试",
    entry: input.market.markPrice, stop: input.market.markPrice - 5, target: 0,
    stopDistancePct: 5, rewardRisk: 2.2, leverage: 10, marginPct: 10, riskPct: 1,
    reasons: [], signalCloseTime: input.now, stateVersion: input.stateVersion,
    sourceGeneration: 0, atr15: 10, createdAt: new Date(input.now).toISOString(),
  };
}

describe("样本外验证报告", () => {
  it("按时间顺序分段并汇总每个 READY 的信号结果", async () => {
    const progress: string[] = [];
    const report = await runValidationReport(["BTCUSDT"], "15m", 30, {
      data: { BTCUSDT: symbolData },
      settings,
      analyze,
      persist: false,
      now: () => START + 100_000_000,
      onProgress: (message) => progress.push(message),
    });

    expect(report.segments.map((segment) => segment.segment)).toEqual(["TRAIN", "VALIDATION", "TEST"]);
    expect(report.segments.map((segment) => segment.result.bars)).toEqual([18, 6, 6]);
    expect(report.aggregate.totalSignals).toBe(3);
    expect(report.aggregate.filledSignals).toBe(3);
    expect(report.aggregate.totalTrades).toBe(3);
    expect(report.outOfSample.totalTrades).toBe(1);
    expect(report.segments.flatMap((segment) => segment.result.signals).every((signal) => signal.mfeR !== null && signal.maeR !== null)).toBe(true);
    expect(progress.some((message) => message.includes("TEST"))).toBe(true);
  });
});
