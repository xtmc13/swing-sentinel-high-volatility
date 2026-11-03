ALTER TABLE `live_intents` ADD COLUMN `tick_size` decimal(65,30) NULL AFTER `stop_price`;
--> statement-breakpoint
ALTER TABLE `live_positions` ADD COLUMN `initial_stop_price` decimal(65,30) NULL AFTER `entry_price`;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `live_daily_risk` (
  `day_key` varchar(10) NOT NULL,
  `day_start_equity` decimal(65,30) NOT NULL,
  `daily_locked` boolean NOT NULL DEFAULT false,
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `live_daily_risk_day_key` PRIMARY KEY(`day_key`)
);
