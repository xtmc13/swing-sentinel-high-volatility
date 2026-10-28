export type Side = "LONG" | "SHORT";
export type DataSource = "MAINNET" | "TESTNET";
export type OpportunityStatus = "READY" | "WAIT" | "BLOCKED";
export type EngineState = "RUNNING" | "PAUSED" | "LOCKED" | "DEGRADED";
export type VolatilityMode = "NORMAL" | "HIGH" | "EXTREME";

export interface MarketQuality {
  valid: boolean;
  reasons: string[];
  bookAgeMs: number | null;
  markAgeMs: number | null;
  candleAgeMs: number | null;
}

export interface VolatilityMetrics {
  atrQuantile: number | null;
  tickSigma: number | null;
  spreadRatio: number | null;
}

export interface VolatilityState {
  symbol: string;
  mode: VolatilityMode;
  confirmationCount: number;
  stableSince: number | null;
  metrics: VolatilityMetrics;
  lastDataAt: number;
  version: number;
}

export interface Candle {
  time: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Market {
  symbol: string;
  baseAsset: string;
  price: number;
  markPrice: number;
  change24h: number;
  quoteVolume: number;
  spreadBps: number;
  fundingRate: number;
  high24h: number;
  low24h: number;
  maxLeverage: number;
  liquidityScore: number;
  eligible: boolean;
  filterReason: string;
}

export interface TradingSettings {
  autoTrade: boolean;
  riskPerTradePct: number;
  marginPerTradePct: number;
  maxPositions: number;
  totalMarginCapPct: number;
  dailyLossLimitPct: number;
  leverageMode: "SYMBOL_MAX" | "FIXED";
  fixedLeverage: number;
  takerFeeBps: number;
  slippageBps: number;
  minQuoteVolume: number;
  maxSpreadBps: number;
  atrBaselineDays: number;
  atrBaselineMinSamples: number;
  atrHighPercentile: number;
  atrExtremePercentile: number;
  tickHighSigma: number;
  tickExtremeSigma: number;
  minTickVolatility: number;
  highVolatilityConfirmations: number;
  stableRecoverySeconds: number;
  normalScanIntervalSeconds: number;
  highRiskCheckIntervalSeconds: number;
  highVolatilityRiskMultiplier: number;
  portfolioStopRiskPct: number;
  correlatedDirectionRiskPct: number;
  correlationThreshold: number;
  correlationWindow: number;
  maxSignalAgeSeconds: number;
  bookStaleSeconds: number;
  candleStaleSeconds: number;
  spreadBaselineMinSamples: number;
  universeSize: number;
}

export interface AccountSnapshot {
  equity: number;
  cash: number;
  availableMargin: number;
  usedMargin: number;
  unrealizedPnl: number;
  realizedPnl: number;
  todayPnl: number;
  todayPnlPct: number;
  dayStartEquity: number;
}

export interface Opportunity {
  id: string;
  symbol: string;
  side: Side;
  status: OpportunityStatus;
  score: number;
  regime: string;
  entry: number;
  stop: number;
  target: number;
  stopDistancePct: number;
  rewardRisk: number;
  leverage: number;
  marginPct: number;
  riskPct: number;
  reasons: string[];
  signalCloseTime: number;
  stateVersion: number;
  sourceGeneration: number;
  atr15?: number;
  createdAt: string;
}

export interface PositionView {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  initialQty: number;
  entryPrice: number;
  markPrice: number;
  stopPrice: number;
  targetPrice: number;
  liquidationPrice: number;
  leverage: number;
  margin: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  realizedPnl: number;
  openedAt: string;
  holdingMinutes: number;
  rMultiple: number;
}

export interface TradeView {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  returnPct: number;
  fees: number;
  holdingMinutes: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
}

export interface OrderView {
  id: string;
  positionId: string;
  symbol: string;
  side: Side;
  purpose: string;
  qty: number;
  price: number;
  fee: number;
  status: string;
  createdAt: string;
}

export interface SystemEvent {
  id: number;
  level: "INFO" | "WARN" | "ERROR" | "SUCCESS";
  category: string;
  symbol: string | null;
  message: string;
  createdAt: string;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  avgHoldingMinutes: number;
  totalFees: number;
}

export interface PortfolioRiskSnapshot {
  totalRisk: number;
  totalRiskPct: number;
  totalLimit: number;
  remainingTotalRisk: number;
  correlatedLimit: number;
  positions: { symbol: string; risk: number; breakeven: boolean }[];
}

export interface WebSocketHealthMetrics {
  running: boolean;
  source: DataSource;
  sourceHealthy: boolean;
  connections: number;
  openConnections: number;
  reconnects: number;
  messages: number;
  malformedMessages: number;
  missedMessages: number | null;
  rateLimits: number;
  degradedSymbols: number;
  lastMessageAt: number | null;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export interface DashboardData {
  source: DataSource;
  sourceLabel: string;
  connected: boolean;
  engineState: EngineState;
  lastScanAt: string | null;
  account: AccountSnapshot;
  settings: TradingSettings;
  markets: Market[];
  opportunities: Opportunity[];
  positions: PositionView[];
  trades: TradeView[];
  orders: OrderView[];
  events: SystemEvent[];
  metrics: PerformanceMetrics;
  equityCurve: { time: string; equity: number }[];
  volatilityStates: VolatilityState[];
  marketQuality: Record<string, MarketQuality>;
  portfolioRisk: PortfolioRiskSnapshot;
  monitor: WebSocketHealthMetrics;
}

export interface BacktestResult {
  id: string;
  symbol: string;
  timeframe: string;
  bars: number;
  initialEquity: number;
  finalEquity: number;
  netPnl: number;
  returnPct: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  totalFees: number;
  assumptions: string[];
  equityCurve: { time: number; equity: number }[];
  trades: TradeView[];
  createdAt: string;
}

export interface HistoricalFundingRate {
  symbol: string;
  fundingTime: number;
  fundingRate: number;
}

export interface PortfolioFundingSettlement {
  time: number;
  symbol: string;
  rate: number;
  notional: number;
  amount: number;
}

export interface PortfolioRiskRejection {
  time: number;
  symbol: string;
  reason: string;
}

export interface PortfolioVolatilityTransition {
  time: number;
  symbol: string;
  from: VolatilityMode;
  to: VolatilityMode;
  version: number;
  reasons: string[];
}

export interface PortfolioBacktestResult extends BacktestResult {
  symbol: "PORTFOLIO";
  symbols: string[];
  tradesBySymbol: Record<string, TradeView[]>;
  funding: PortfolioFundingSettlement[];
  totalFunding: number;
  riskRejections: PortfolioRiskRejection[];
  transitions: PortfolioVolatilityTransition[];
  dailyLossLocks: { time: number; day: string; equity: number; dayStartEquity: number }[];
  dataGaps: string[];
}

export const DEFAULT_SETTINGS: TradingSettings = {
  autoTrade: false,
  riskPerTradePct: 0.35,
  marginPerTradePct: 2,
  maxPositions: 4,
  totalMarginCapPct: 8,
  dailyLossLimitPct: 2,
  leverageMode: "SYMBOL_MAX",
  fixedLeverage: 20,
  takerFeeBps: 5,
  slippageBps: 2,
  minQuoteVolume: 25_000_000,
  maxSpreadBps: 3,
  atrBaselineDays: 7,
  atrBaselineMinSamples: 2016,
  atrHighPercentile: 90,
  atrExtremePercentile: 99,
  tickHighSigma: 3,
  tickExtremeSigma: 5,
  minTickVolatility: 0.0001,
  highVolatilityConfirmations: 2,
  stableRecoverySeconds: 180,
  normalScanIntervalSeconds: 45,
  highRiskCheckIntervalSeconds: 10,
  highVolatilityRiskMultiplier: 0.5,
  portfolioStopRiskPct: 1,
  correlatedDirectionRiskPct: 0.5,
  correlationThreshold: 0.8,
  correlationWindow: 60,
  maxSignalAgeSeconds: 15,
  bookStaleSeconds: 5,
  candleStaleSeconds: 90,
  spreadBaselineMinSamples: 120,
  universeSize: 100,
};
