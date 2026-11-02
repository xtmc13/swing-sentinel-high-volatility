ALTER TABLE `live_positions` ADD `exit_claim_id` varchar(36);--> statement-breakpoint
ALTER TABLE `live_positions` ADD `exit_claimed_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `positions` ADD `exit_claim_id` varchar(36);--> statement-breakpoint
ALTER TABLE `positions` ADD `exit_claimed_at` timestamp(3);