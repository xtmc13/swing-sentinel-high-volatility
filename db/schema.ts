import {
  mysqlTable,
  bigint,
  varchar,
  text,
  timestamp,
  int,
  double,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

export const simulationAccounts = mysqlTable("simulation_accounts", {
  id: int("id").primaryKey().default(1),
  initialBalance: double("initial_balance").notNull().default(100000),
  cash: double("cash").notNull().default(100000),
  realizedPnl: double("realized_pnl").notNull().default(0),
  dayStartEquity: double("day_start_equity").notNull().default(100000),
  dayKey: varchar("day_key", { length: 16 }).notNull().default(""),
  dailyLockDay: varchar("daily_lock_day", { length: 16 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const tradingSettings = mysqlTable("trading_settings", {
  id: int("id").primaryKey().default(1),
  autoTrade: boolean("auto_trade").notNull().default(false),
  riskPerTradePct: double("risk_per_trade_pct").notNull().default(0.35),
  marginPerTradePct: double("margin_per_trade_pct").notNull().default(2),
  maxPositions: int("max_positions").notNull().default(4),
  totalMarginCapPct: double("total_margin_cap_pct").notNull().default(8),
  dailyLossLimitPct: double("daily_loss_limit_pct").notNull().default(2),
  leverageMode: varchar("leverage_mode", { length: 24 }).notNull().default("SYMBOL_MAX"),
  fixedLeverage: int("fixed_leverage").notNull().default(20),
  takerFeeBps: double("taker_fee_bps").notNull().default(5),
  slippageBps: double("slippage_bps").notNull().default(2),
  minQuoteVolume: double("min_quote_volume").notNull().default(25000000),
  maxSpreadBps: double("max_spread_bps").notNull().default(3),
  atrBaselineDays: int("atr_baseline_days").notNull().default(7),
  atrBaselineMinSamples: int("atr_baseline_min_samples").notNull().default(2016),
  atrHighPercentile: double("atr_high_percentile").notNull().default(90),
  atrExtremePercentile: double("atr_extreme_percentile").notNull().default(99),
  tickHighSigma: double("tick_high_sigma").notNull().default(3),
  tickExtremeSigma: double("tick_extreme_sigma").notNull().default(5),
  minTickVolatility: double("min_tick_volatility").notNull().default(0.0001),
  highVolatilityConfirmations: int("high_volatility_confirmations").notNull().default(2),
  stableRecoverySeconds: int("stable_recovery_seconds").notNull().default(180),
  normalScanIntervalSeconds: int("normal_scan_interval_seconds").notNull().default(45),
  highRiskCheckIntervalSeconds: int("high_risk_check_interval_seconds").notNull().default(10),
  highVolatilityRiskMultiplier: double("high_volatility_risk_multiplier").notNull().default(0.5),
  portfolioStopRiskPct: double("portfolio_stop_risk_pct").notNull().default(1),
  correlatedDirectionRiskPct: double("correlated_direction_risk_pct").notNull().default(0.5),
  correlationThreshold: double("correlation_threshold").notNull().default(0.8),
  correlationWindow: int("correlation_window").notNull().default(60),
  maxSignalAgeSeconds: int("max_signal_age_seconds").notNull().default(15),
  bookStaleSeconds: int("book_stale_seconds").notNull().default(5),
  candleStaleSeconds: int("candle_stale_seconds").notNull().default(90),
  spreadBaselineMinSamples: int("spread_baseline_min_samples").notNull().default(120),
  universeSize: int("universe_size").notNull().default(100),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const positions = mysqlTable("positions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  side: varchar("side", { length: 8 }).notNull(),
  status: varchar("status", { length: 12 }).notNull().default("OPEN"),
  initialQty: double("initial_qty").notNull(),
  qty: double("qty").notNull(),
  entryPrice: double("entry_price").notNull(),
  stopPrice: double("stop_price").notNull(),
  targetPrice: double("target_price").notNull(),
  liquidationPrice: double("liquidation_price").notNull(),
  leverage: int("leverage").notNull(),
  margin: double("margin").notNull(),
  fees: double("fees").notNull().default(0),
  fundingPnl: double("funding_pnl").notNull().default(0),
  realizedPnl: double("realized_pnl").notNull().default(0),
  maxFavorableR: double("max_favorable_r").notNull().default(0),
  initialRisk: double("initial_risk").notNull(),
  openedAt: timestamp("opened_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  closedAt: timestamp("closed_at"),
}, (table) => ({ statusIdx: index("positions_status_idx").on(table.status) }));

export const volatilityStates = mysqlTable("volatility_states", {
  symbol: varchar("symbol", { length: 24 }).primaryKey(),
  mode: varchar("mode", { length: 8 }).notNull().default("NORMAL"),
  confirmationCount: int("confirmation_count").notNull().default(0),
  stableSince: bigint("stable_since", { mode: "number" }),
  atrQuantile: double("atr_quantile"),
  tickSigma: double("tick_sigma"),
  spreadRatio: double("spread_ratio"),
  lastDataAt: bigint("last_data_at", { mode: "number" }).notNull(),
  version: int("version").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const executionOrders = mysqlTable("execution_orders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  positionId: varchar("position_id", { length: 36 }).notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  side: varchar("side", { length: 8 }).notNull(),
  purpose: varchar("purpose", { length: 32 }).notNull(),
  qty: double("qty").notNull(),
  price: double("price").notNull(),
  fee: double("fee").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("FILLED"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({ positionIdx: index("orders_position_idx").on(table.positionId) }));

export const fundingSettlements = mysqlTable("funding_settlements", {
  id: varchar("id", { length: 36 }).primaryKey(),
  positionId: varchar("position_id", { length: 36 }).notNull(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  fundingTime: bigint("funding_time", { mode: "number" }).notNull(),
  rate: double("rate").notNull(),
  notional: double("notional").notNull(),
  amount: double("amount").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  positionFundingUnique: uniqueIndex("funding_position_time_unique").on(table.positionId, table.fundingTime),
  symbolTimeIdx: index("funding_symbol_time_idx").on(table.symbol, table.fundingTime),
}));

export const closedTrades = mysqlTable("closed_trades", {
  id: varchar("id", { length: 36 }).primaryKey(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  side: varchar("side", { length: 8 }).notNull(),
  qty: double("qty").notNull(),
  entryPrice: double("entry_price").notNull(),
  exitPrice: double("exit_price").notNull(),
  pnl: double("pnl").notNull(),
  returnPct: double("return_pct").notNull(),
  fees: double("fees").notNull(),
  fundingPnl: double("funding_pnl").notNull().default(0),
  holdingMinutes: double("holding_minutes").notNull(),
  exitReason: varchar("exit_reason", { length: 64 }).notNull(),
  openedAt: timestamp("opened_at").notNull(),
  closedAt: timestamp("closed_at").notNull().defaultNow(),
}, (table) => ({ closedIdx: index("trades_closed_idx").on(table.closedAt) }));

export const systemEvents = mysqlTable("system_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  level: varchar("level", { length: 12 }).notNull(),
  category: varchar("category", { length: 32 }).notNull(),
  symbol: varchar("symbol", { length: 24 }),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({ createdIdx: index("events_created_idx").on(table.createdAt) }));

export const equitySnapshots = mysqlTable("equity_snapshots", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  equity: double("equity").notNull(),
  cash: double("cash").notNull(),
  unrealized: double("unrealized").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const backtestRuns = mysqlTable("backtest_runs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  symbol: varchar("symbol", { length: 24 }).notNull(),
  timeframe: varchar("timeframe", { length: 8 }).notNull(),
  bars: int("bars").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
