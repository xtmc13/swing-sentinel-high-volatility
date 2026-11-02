ALTER TABLE `live_fills` DROP INDEX `live_fills_trade_unique`;--> statement-breakpoint
ALTER TABLE `live_orders` DROP INDEX `live_orders_exchange_order_unique`;--> statement-breakpoint
ALTER TABLE `live_fills` ADD CONSTRAINT `live_fills_trade_unique` UNIQUE(`symbol`,`exchange_trade_id`);--> statement-breakpoint
ALTER TABLE `live_orders` ADD CONSTRAINT `live_orders_exchange_order_unique` UNIQUE(`symbol`,`exchange_order_id`);