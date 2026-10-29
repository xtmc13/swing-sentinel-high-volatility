import type { PortfolioBacktestResult, SignalEvaluation } from "./trading";

export type ValidationSegmentName = "TRAIN" | "VALIDATION" | "TEST";

export interface ValidationMetrics {
  totalSignals: number;
  filledSignals: number;
  rejectedSignals: number;
  fillRatePct: number;
  totalTrades: number;
  winRatePct: number;
  netPnl: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalFees: number;
  totalFunding: number;
  averageR: number;
  averageMfeR: number;
  averageMaeR: number;
  averageFillDeviationBps: number;
}

export interface ValidationSegmentReport {
  segment: ValidationSegmentName;
  startOpenTime: number;
  endCloseTime: number;
  result: PortfolioBacktestResult;
  metrics: ValidationMetrics;
}

export interface ValidationReport {
  id: string;
  symbols: string[];
  timeframe: "5m" | "15m";
  bars: number;
  createdAt: string;
  segments: ValidationSegmentReport[];
  aggregate: ValidationMetrics;
  outOfSample: ValidationMetrics;
  assumptions: string[];
}

export interface ValidationReportSummary {
  id: string;
  symbols: string[];
  timeframe: "5m" | "15m";
  bars: number;
  createdAt: string;
  outOfSample: ValidationMetrics;
}

export interface ValidationJobView {
  id: string;
  status: "RUNNING" | "COMPLETE" | "FAILED";
  progress: string;
  createdAt: string;
  error: string | null;
  report: ValidationReport | null;
}

export type { SignalEvaluation };
