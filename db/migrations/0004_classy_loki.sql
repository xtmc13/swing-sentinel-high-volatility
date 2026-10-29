CREATE TABLE `funding_settlements` (
	`id` varchar(36) NOT NULL,
	`position_id` varchar(36) NOT NULL,
	`symbol` varchar(24) NOT NULL,
	`funding_time` bigint NOT NULL,
	`rate` double NOT NULL,
	`notional` double NOT NULL,
	`amount` double NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `funding_settlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `funding_position_time_unique` UNIQUE(`position_id`,`funding_time`)
);
--> statement-breakpoint
ALTER TABLE `closed_trades` ADD `funding_pnl` double DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `funding_pnl` double DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `simulation_accounts` ADD `daily_lock_day` varchar(16);--> statement-breakpoint
CREATE INDEX `funding_symbol_time_idx` ON `funding_settlements` (`symbol`,`funding_time`);