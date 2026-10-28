SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `atr_baseline_days` int NOT NULL DEFAULT 7 AFTER `max_spread_bps`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'atr_baseline_days');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `atr_baseline_min_samples` int NOT NULL DEFAULT 2016 AFTER `atr_baseline_days`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'atr_baseline_min_samples');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `atr_high_percentile` double NOT NULL DEFAULT 90 AFTER `atr_baseline_min_samples`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'atr_high_percentile');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `atr_extreme_percentile` double NOT NULL DEFAULT 99 AFTER `atr_high_percentile`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'atr_extreme_percentile');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `tick_high_sigma` double NOT NULL DEFAULT 3 AFTER `atr_extreme_percentile`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'tick_high_sigma');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `tick_extreme_sigma` double NOT NULL DEFAULT 5 AFTER `tick_high_sigma`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'tick_extreme_sigma');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `min_tick_volatility` double NOT NULL DEFAULT 0.0001 AFTER `tick_extreme_sigma`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'min_tick_volatility');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `high_volatility_confirmations` int NOT NULL DEFAULT 2 AFTER `min_tick_volatility`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'high_volatility_confirmations');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `stable_recovery_seconds` int NOT NULL DEFAULT 180 AFTER `high_volatility_confirmations`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'stable_recovery_seconds');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `normal_scan_interval_seconds` int NOT NULL DEFAULT 45 AFTER `stable_recovery_seconds`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'normal_scan_interval_seconds');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `high_risk_check_interval_seconds` int NOT NULL DEFAULT 10 AFTER `normal_scan_interval_seconds`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'high_risk_check_interval_seconds');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `high_volatility_risk_multiplier` double NOT NULL DEFAULT 0.5 AFTER `high_risk_check_interval_seconds`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'high_volatility_risk_multiplier');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `portfolio_stop_risk_pct` double NOT NULL DEFAULT 1 AFTER `high_volatility_risk_multiplier`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'portfolio_stop_risk_pct');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `correlated_direction_risk_pct` double NOT NULL DEFAULT 0.5 AFTER `portfolio_stop_risk_pct`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'correlated_direction_risk_pct');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `correlation_threshold` double NOT NULL DEFAULT 0.8 AFTER `correlated_direction_risk_pct`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'correlation_threshold');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `correlation_window` int NOT NULL DEFAULT 60 AFTER `correlation_threshold`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'correlation_window');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `max_signal_age_seconds` int NOT NULL DEFAULT 15 AFTER `correlation_window`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'max_signal_age_seconds');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `book_stale_seconds` int NOT NULL DEFAULT 5 AFTER `max_signal_age_seconds`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'book_stale_seconds');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `candle_stale_seconds` int NOT NULL DEFAULT 90 AFTER `book_stale_seconds`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'candle_stale_seconds');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `trading_settings` ADD COLUMN `spread_baseline_min_samples` int NOT NULL DEFAULT 120 AFTER `candle_stale_seconds`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_settings' AND COLUMN_NAME = 'spread_baseline_min_samples');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
ALTER TABLE `trading_settings` MODIFY COLUMN `universe_size` int NOT NULL DEFAULT 100;
--> statement-breakpoint
SET @ddl = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `positions` ADD COLUMN `initial_risk` double NULL AFTER `max_favorable_r`', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'positions' AND COLUMN_NAME = 'initial_risk');
--> statement-breakpoint
PREPARE high_volatility_stmt FROM @ddl;
--> statement-breakpoint
EXECUTE high_volatility_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE high_volatility_stmt;
--> statement-breakpoint
UPDATE `positions` SET `initial_risk` = GREATEST(ABS(`entry_price` - `stop_price`), 0.00000001) WHERE `initial_risk` IS NULL OR `initial_risk` <= 0;
--> statement-breakpoint
ALTER TABLE `positions` MODIFY COLUMN `initial_risk` double NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `volatility_states` (
  `symbol` varchar(24) NOT NULL,
  `mode` varchar(8) NOT NULL DEFAULT 'NORMAL',
  `confirmation_count` int NOT NULL DEFAULT 0,
  `stable_since` bigint NULL,
  `atr_quantile` double NULL,
  `tick_sigma` double NULL,
  `spread_ratio` double NULL,
  `last_data_at` bigint NOT NULL,
  `version` int NOT NULL DEFAULT 0,
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `volatility_states_symbol` PRIMARY KEY(`symbol`)
);
