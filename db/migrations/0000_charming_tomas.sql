CREATE TABLE `backtest_runs` (
	`id` varchar(36) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`timeframe` varchar(8) NOT NULL,
	`bars` int NOT NULL,
	`result_json` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `backtest_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `closed_trades` (
	`id` varchar(36) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`side` varchar(8) NOT NULL,
	`qty` double NOT NULL,
	`entry_price` double NOT NULL,
	`exit_price` double NOT NULL,
	`pnl` double NOT NULL,
	`return_pct` double NOT NULL,
	`fees` double NOT NULL,
	`holding_minutes` double NOT NULL,
	`exit_reason` varchar(64) NOT NULL,
	`opened_at` timestamp NOT NULL,
	`closed_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `closed_trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `equity_snapshots` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`equity` double NOT NULL,
	`cash` double NOT NULL,
	`unrealized` double NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `equity_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `execution_orders` (
	`id` varchar(36) NOT NULL,
	`position_id` varchar(36) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`side` varchar(8) NOT NULL,
	`purpose` varchar(32) NOT NULL,
	`qty` double NOT NULL,
	`price` double NOT NULL,
	`fee` double NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'FILLED',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `execution_orders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `positions` (
	`id` varchar(36) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`side` varchar(8) NOT NULL,
	`status` varchar(12) NOT NULL DEFAULT 'OPEN',
	`initial_qty` double NOT NULL,
	`qty` double NOT NULL,
	`entry_price` double NOT NULL,
	`stop_price` double NOT NULL,
	`target_price` double NOT NULL,
	`liquidation_price` double NOT NULL,
	`leverage` int NOT NULL,
	`margin` double NOT NULL,
	`fees` double NOT NULL DEFAULT 0,
	`realized_pnl` double NOT NULL DEFAULT 0,
	`max_favorable_r` double NOT NULL DEFAULT 0,
	`opened_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`closed_at` timestamp,
	CONSTRAINT `positions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `simulation_accounts` (
	`id` int NOT NULL DEFAULT 1,
	`initial_balance` double NOT NULL DEFAULT 100000,
	`cash` double NOT NULL DEFAULT 100000,
	`realized_pnl` double NOT NULL DEFAULT 0,
	`day_start_equity` double NOT NULL DEFAULT 100000,
	`day_key` varchar(16) NOT NULL DEFAULT '',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `simulation_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `system_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`level` varchar(12) NOT NULL,
	`category` varchar(32) NOT NULL,
	`symbol` varchar(24),
	`message` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `system_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trading_settings` (
	`id` int NOT NULL DEFAULT 1,
	`auto_trade` boolean NOT NULL DEFAULT true,
	`risk_per_trade_pct` double NOT NULL DEFAULT 0.35,
	`margin_per_trade_pct` double NOT NULL DEFAULT 2,
	`max_positions` int NOT NULL DEFAULT 4,
	`total_margin_cap_pct` double NOT NULL DEFAULT 8,
	`daily_loss_limit_pct` double NOT NULL DEFAULT 2,
	`leverage_mode` varchar(24) NOT NULL DEFAULT 'SYMBOL_MAX',
	`fixed_leverage` int NOT NULL DEFAULT 20,
	`taker_fee_bps` double NOT NULL DEFAULT 5,
	`slippage_bps` double NOT NULL DEFAULT 2,
	`min_quote_volume` double NOT NULL DEFAULT 25000000,
	`max_spread_bps` double NOT NULL DEFAULT 3,
	`universe_size` int NOT NULL DEFAULT 12,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `trading_settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `trades_closed_idx` ON `closed_trades` (`closed_at`);--> statement-breakpoint
CREATE INDEX `orders_position_idx` ON `execution_orders` (`position_id`);--> statement-breakpoint
CREATE INDEX `positions_status_idx` ON `positions` (`status`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `system_events` (`created_at`);