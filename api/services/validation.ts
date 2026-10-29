import type { TradingSettings } from "@contracts/trading";
import type {
  ValidationMetrics,
  ValidationReport,
  ValidationSegmentName,
  ValidationSegmentReport,
} from "@contracts/validation";
import { getSettings } from "../queries/trading";
import { persistValidationReport } from "../queries/validation";
import {
  loadPortfolioData,
  runPortfolioBacktest,
  type PortfolioSymbolData,
  type PortfolioTimeframe,
  type PortfolioBacktestDependencies,
} from "./portfolioBacktest";

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function metricsForResults(results: ValidationSegmentReport["result"][]): ValidationMetrics {
  const signals = results.flatMap((result) => result.signals);
  const trades = results.flatMap((result) => result.trades);
  const filled = signals.filter((signal) => signal.status === "FILLED");
  const rejected = signals.filter((signal) => signal.status === "REJECTED");
  const wins = trades.filter((trade) => trade.pnl > 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const netPnl = results.reduce((sum, result) => sum + result.netPnl, 0);
  return {
    totalSignals: signals.length,
    filledSignals: filled.length,
    rejectedSignals: rejected.length,
    fillRatePct: signals.length ? filled.length / signals.length * 100 : 0,
    totalTrades: trades.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    netPnl,
    expectancy: mean(trades.map((trade) => trade.pnl)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
    maxDrawdownPct: results.length ? Math.max(...results.map((result) => result.maxDrawdown)) : 0,
    totalFees: results.reduce((sum, result) => sum + result.totalFees, 0),
    totalFunding: results.reduce((sum, result) => sum + result.totalFunding, 0),
    averageR: mean(filled.flatMap((signal) => signal.rMultiple === null ? [] : [signal.rMultiple])),
    averageMfeR: mean(filled.flatMap((signal) => signal.mfeR === null ? [] : [signal.mfeR])),
    averageMaeR: mean(filled.flatMap((signal) => signal.maeR === null ? [] : [signal.maeR])),
    averageFillDeviationBps: mean(filled.flatMap((signal) => signal.fillDeviationBps === null ? [] : [signal.fillDeviationBps])),
  };
}

export interface ValidationRunDependencies {
  data?: Record<string, PortfolioSymbolData>;
  settings?: TradingSettings;
  now?: () => number;
  persist?: boolean;
  analyze?: PortfolioBacktestDependencies["analyze"];
  evaluate?: PortfolioBacktestDependencies["evaluate"];
  onProgress?: (progress: string) => void;
}

export async function runValidationReport(
  symbols: string[],
  timeframe: PortfolioTimeframe,
  bars: number,
  dependencies: ValidationRunDependencies = {},
): Promise<ValidationReport> {
  if (!Array.isArray(symbols) || symbols.length === 0 || new Set(symbols).size !== symbols.length) {
    throw new Error("验证报告需要不重复的合约列表");
  }
  if (!Number.isInteger(bars) || bars < 30) throw new Error("样本外验证至少需要 30 根主时间轴K线");
  const now = dependencies.now ?? Date.now;
  dependencies.onProgress?.("读取风险参数并加载历史行情");
  const settings = dependencies.settings ?? await getSettings();
  const data = dependencies.data ?? await loadPortfolioData(symbols, timeframe, bars, settings, now());
  const reference = data[symbols[0]]?.candles[timeframe];
  if (!reference || reference.length < bars) throw new Error("验证报告的历史K线不足");
  const timeline = reference.slice(-bars);
  const trainEnd = Math.floor(bars * 0.6);
  const validationEnd = Math.floor(bars * 0.8);
  const definitions: { segment: ValidationSegmentName; start: number; end: number }[] = [
    { segment: "TRAIN", start: 0, end: trainEnd },
    { segment: "VALIDATION", start: trainEnd, end: validationEnd },
    { segment: "TEST", start: validationEnd, end: bars },
  ];
  if (definitions.some((item) => item.end - item.start < 2)) throw new Error("样本分段后K线不足");

  const segments: ValidationSegmentReport[] = [];
  for (const definition of definitions) {
    dependencies.onProgress?.(`运行 ${definition.segment} 区间回测`);
    const slice = timeline.slice(definition.start, definition.end);
    const startOpenTime = slice[0].time * 1000;
    const endCloseTime = slice.at(-1)!.closeTime;
    const result = await runPortfolioBacktest(symbols, timeframe, slice.length, {
      data,
      settings,
      initialEquity: 100_000,
      persist: false,
      now,
      analyze: dependencies.analyze,
      evaluate: dependencies.evaluate,
      window: { startOpenTime, endCloseTime },
    });
    segments.push({ segment: definition.segment, startOpenTime, endCloseTime, result, metrics: metricsForResults([result]) });
  }
  const aggregate = metricsForResults(segments.map((segment) => segment.result));
  const outOfSample = segments.find((segment) => segment.segment === "TEST")!.metrics;
  const report: ValidationReport = {
    id: crypto.randomUUID(),
    symbols: [...symbols],
    timeframe,
    bars,
    createdAt: new Date(now()).toISOString(),
    segments,
    aggregate,
    outOfSample,
    assumptions: [
      "按时间顺序 60%／20%／20% 划分训练、验证和样本外区间；不随机打乱K线",
      "每段使用相同参数和独立 100,000 USDT 初始权益，指标不跨段延续持仓或日亏状态",
      "信号日志覆盖每个 READY 的成交与风险拒绝，并记录净R、MFE、MAE和成交偏差",
      "历史合约池存在当前流动性与存续偏差；样本外结果仍需前向模拟复核，不代表未来盈利",
    ],
  };
  if (dependencies.persist !== false) await persistValidationReport(report);
  return report;
}
