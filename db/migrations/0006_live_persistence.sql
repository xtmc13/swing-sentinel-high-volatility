CREATE TABLE `execution_intents` (
	`id` varchar(36) NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'PENDING_SEND',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `execution_intents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `live_account_snapshots` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`asset` varchar(12) NOT NULL,
	`wallet_balance` decimal(65,30) NOT NULL,
	`available_balance` decimal(65,30) NOT NULL,
	`cross_wallet_balance` decimal(65,30) NOT NULL,
	`observed_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `live_account_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `live_controls` (
	`id` int NOT NULL DEFAULT 1,
	`armed` boolean NOT NULL DEFAULT false,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `live_controls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `live_fills` (
	`id` varchar(36) NOT NULL,
	`order_id` varchar(36) NOT NULL,
	`exchange_trade_id` varchar(64) NOT NULL,
	`exchange_order_id` varchar(64) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`side` varchar(8) NOT NULL,
	`price` decimal(65,30) NOT NULL,
	`quantity` decimal(65,30) NOT NULL,
	`quote_quantity` decimal(65,30) NOT NULL,
	`commission` decimal(65,30) NOT NULL,
	`commission_asset` varchar(12) NOT NULL,
	`realized_pnl` decimal(65,30) NOT NULL,
	`is_maker` boolean NOT NULL DEFAULT false,
	`executed_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `live_fills_id` PRIMARY KEY(`id`),
	CONSTRAINT `live_fills_trade_unique` UNIQUE(`exchange_trade_id`)
);
--> statement-breakpoint
CREATE TABLE `live_intents` (
	`id` varchar(36) NOT NULL,
	`signal_id` varchar(160) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`side` varchar(8) NOT NULL,
	`status` varchar(24) NOT NULL DEFAULT 'PENDING_SEND',
	`quantity` decimal(65,30) NOT NULL,
	`limit_price` decimal(65,30) NOT NULL,
	`stop_price` decimal(65,30) NOT NULL,
	`liquidation_price` decimal(65,30) NOT NULL,
	`leverage` int NOT NULL,
	`notional` decimal(65,30) NOT NULL,
	`reserved_margin` decimal(65,30) NOT NULL,
	`reserved_risk` decimal(65,30) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`expires_at` timestamp(3) NOT NULL,
	`lease_owner` varchar(80),
	`lease_expires_at` timestamp(3),
	`last_error` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `live_intents_id` PRIMARY KEY(`id`),
	CONSTRAINT `live_intents_signal_unique` UNIQUE(`signal_id`)
);
--> statement-breakpoint
CREATE TABLE `live_ledger_entries` (
	`id` varchar(36) NOT NULL,
	`exchange_transaction_id` varchar(64) NOT NULL,
	`symbol` varchar(24),
	`asset` varchar(12) NOT NULL,
	`entry_type` varchar(32) NOT NULL,
	`amount` decimal(65,30) NOT NULL,
	`occurred_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `live_ledger_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `live_ledger_transaction_unique` UNIQUE(`exchange_transaction_id`)
);
--> statement-breakpoint
CREATE TABLE `live_orders` (
	`id` varchar(36) NOT NULL,
	`intent_id` varchar(36) NOT NULL,
	`client_order_id` varchar(64) NOT NULL,
	`exchange_order_id` varchar(64),
	`symbol` varchar(24) NOT NULL,
	`side` varchar(8) NOT NULL,
	`type` varchar(24) NOT NULL,
	`status` varchar(24) NOT NULL,
	`price` decimal(65,30) NOT NULL,
	`original_quantity` decimal(65,30) NOT NULL,
	`executed_quantity` decimal(65,30) NOT NULL,
	`reduce_only` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `live_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `live_orders_client_order_unique` UNIQUE(`client_order_id`),
	CONSTRAINT `live_orders_exchange_order_unique` UNIQUE(`exchange_order_id`)
);
--> statement-breakpoint
CREATE TABLE `live_positions` (
	`id` varchar(36) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`side` varchar(8) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'OPEN',
	`initial_quantity` decimal(65,30) NOT NULL,
	`quantity` decimal(65,30) NOT NULL,
	`entry_price` decimal(65,30) NOT NULL,
	`mark_price` decimal(65,30) NOT NULL,
	`liquidation_price` decimal(65,30) NOT NULL,
	`isolated_wallet` decimal(65,30) NOT NULL,
	`leverage` decimal(65,30) NOT NULL,
	`maintenance_bracket` int NOT NULL,
	`maint_margin_ratio` decimal(65,30) NOT NULL,
	`cum_maintenance` decimal(65,30) NOT NULL,
	`opened_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`closed_at` timestamp(3),
	CONSTRAINT `live_positions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reconciliation_issues` (
	`id` varchar(36) NOT NULL,
	`category` varchar(32) NOT NULL,
	`severity` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'OPEN',
	`symbol` varchar(24),
	`expected_value` decimal(65,30),
	`actual_value` decimal(65,30),
	`message` text NOT NULL,
	`detected_at` timestamp(3) NOT NULL,
	`resolved_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reconciliation_issues_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `trading_settings` ADD `execution_mode` varchar(16) DEFAULT 'PAPER' NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_settings` ADD `strategy_mode` varchar(16) DEFAULT 'SWING' NOT NULL;--> statement-breakpoint
ALTER TABLE `trading_settings` ADD `momentum_enabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `execution_intents_status_idx` ON `execution_intents` (`status`);--> statement-breakpoint
CREATE INDEX `live_account_asset_observed_idx` ON `live_account_snapshots` (`asset`,`observed_at`);--> statement-breakpoint
CREATE INDEX `live_fills_order_idx` ON `live_fills` (`order_id`);--> statement-breakpoint
CREATE INDEX `live_fills_exchange_order_idx` ON `live_fills` (`exchange_order_id`);--> statement-breakpoint
CREATE INDEX `live_intents_status_idx` ON `live_intents` (`status`);--> statement-breakpoint
CREATE INDEX `live_intents_lease_idx` ON `live_intents` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `live_ledger_occurred_idx` ON `live_ledger_entries` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `live_orders_intent_idx` ON `live_orders` (`intent_id`);--> statement-breakpoint
CREATE INDEX `live_orders_status_idx` ON `live_orders` (`status`);--> statement-breakpoint
CREATE INDEX `live_positions_symbol_status_idx` ON `live_positions` (`symbol`,`status`);--> statement-breakpoint
CREATE INDEX `reconciliation_status_severity_idx` ON `reconciliation_issues` (`status`,`severity`);