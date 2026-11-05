ALTER TABLE `live_intents`
  ADD COLUMN `notional_cap` decimal(65,30),
  ADD COLUMN `notional_floor` decimal(65,30),
  ADD COLUMN `initial_leverage` int;
--> statement-breakpoint
ALTER TABLE `live_orders`
  ADD COLUMN `notional_cap` decimal(65,30),
  ADD COLUMN `notional_floor` decimal(65,30),
  ADD COLUMN `initial_leverage` int;
