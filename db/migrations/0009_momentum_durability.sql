CREATE TABLE `momentum_frames` (
	`symbol` varchar(24) NOT NULL,
	`event_time` bigint NOT NULL,
	`received_time` bigint NOT NULL,
	`sequence` bigint NOT NULL,
	`generation` bigint NOT NULL,
	`quality` varchar(32) NOT NULL,
	`config_hash` varchar(64) NOT NULL,
	`mark_price` double,
	`microprice` double,
	`spread_bps` double,
	`depth_imbalance` double,
	`aggressive_buy_volume` double NOT NULL,
	`aggressive_sell_volume` double NOT NULL,
	`short_return` double,
	`burst_z` double,
	`realized_volatility` double,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `momentum_frames_symbol` PRIMARY KEY(`symbol`)
);
--> statement-breakpoint
ALTER TABLE `live_intents` ADD `strategy_type` varchar(16) DEFAULT 'SWING' NOT NULL;--> statement-breakpoint
ALTER TABLE `live_intents` ADD `breakout_price` decimal(65,30);--> statement-breakpoint
ALTER TABLE `live_orders` ADD `max_entry_price` decimal(65,30);--> statement-breakpoint
ALTER TABLE `live_positions` ADD `signal_id` varchar(160);--> statement-breakpoint
ALTER TABLE `live_positions` ADD `strategy_type` varchar(16) DEFAULT 'SWING' NOT NULL;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `breakout_price` decimal(65,30);--> statement-breakpoint
ALTER TABLE `live_positions` ADD `exit_pending` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `live_positions` ADD `exit_reason` varchar(64);--> statement-breakpoint
ALTER TABLE `positions` ADD `signal_id` varchar(160);--> statement-breakpoint
ALTER TABLE `positions` ADD `strategy_type` varchar(16) DEFAULT 'SWING' NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `breakout_price` double;--> statement-breakpoint
ALTER TABLE `positions` ADD `exit_pending` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `exit_reason` varchar(64);--> statement-breakpoint
ALTER TABLE `positions` ADD CONSTRAINT `positions_signal_unique` UNIQUE(`signal_id`);