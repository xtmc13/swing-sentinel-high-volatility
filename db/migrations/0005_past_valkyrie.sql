CREATE TABLE `validation_reports` (
	`id` varchar(36) NOT NULL,
	`symbols_json` text NOT NULL,
	`timeframe` varchar(8) NOT NULL,
	`bars` int NOT NULL,
	`report_json` longtext NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `validation_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `validation_reports_created_idx` ON `validation_reports` (`created_at`);