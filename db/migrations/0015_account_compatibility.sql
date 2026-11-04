ALTER TABLE `live_intents`
  ADD COLUMN `position_side` varchar(8),
  ADD COLUMN `margin_type` varchar(16),
  ADD COLUMN `entry_semantics` varchar(16),
  ADD COLUMN `effective_leverage` int,
  ADD COLUMN `maintenance_bracket` int,
  ADD COLUMN `maint_margin_ratio` decimal(65,30),
  ADD COLUMN `cum_maintenance` decimal(65,30),
  ADD COLUMN `liquidation_price_source` varchar(24) NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  ADD COLUMN `account_mode_fingerprint` varchar(64),
  ADD COLUMN `compatibility_frozen` boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE `live_orders`
  ADD COLUMN `position_side` varchar(8),
  ADD COLUMN `margin_type` varchar(16),
  ADD COLUMN `entry_semantics` varchar(16),
  ADD COLUMN `effective_leverage` int,
  ADD COLUMN `maintenance_bracket` int,
  ADD COLUMN `maint_margin_ratio` decimal(65,30),
  ADD COLUMN `cum_maintenance` decimal(65,30),
  ADD COLUMN `liquidation_price_source` varchar(24) NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  ADD COLUMN `account_mode_fingerprint` varchar(64),
  ADD COLUMN `compatibility_frozen` boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE `live_positions`
  ADD COLUMN `position_side` varchar(8),
  ADD COLUMN `margin_type` varchar(16),
  ADD COLUMN `entry_semantics` varchar(16),
  ADD COLUMN `effective_leverage` int,
  ADD COLUMN `liquidation_price_source` varchar(24) NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  ADD COLUMN `account_mode_fingerprint` varchar(64),
  ADD COLUMN `compatibility_frozen` boolean NOT NULL DEFAULT true;
--> statement-breakpoint
UPDATE `live_intents`
SET
  `position_side` = `side`,
  `entry_semantics` = 'ENTRY',
  `effective_leverage` = `leverage`,
  `liquidation_price_source` = 'LEGACY_UNKNOWN',
  `compatibility_frozen` = `status` NOT IN ('FILLED', 'CANCEL', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED');
--> statement-breakpoint
UPDATE `live_orders` AS `orders`
LEFT JOIN `live_intents` AS `intents` ON `intents`.`id` = `orders`.`intent_id`
SET
  `orders`.`position_side` = `orders`.`side`,
  `orders`.`entry_semantics` = IF(`orders`.`reduce_only`, 'REDUCE', 'ENTRY'),
  `orders`.`effective_leverage` = `intents`.`leverage`,
  `orders`.`liquidation_price_source` = 'LEGACY_UNKNOWN',
  `orders`.`compatibility_frozen` = `orders`.`status` NOT IN ('FILLED', 'CANCEL', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED');
--> statement-breakpoint
UPDATE `live_positions`
SET
  `position_side` = `side`,
  `entry_semantics` = 'ENTRY',
  `effective_leverage` = CAST(`leverage` AS SIGNED),
  `liquidation_price_source` = 'LEGACY_UNKNOWN',
  `compatibility_frozen` = `status` <> 'CLOSED';
--> statement-breakpoint
UPDATE `trading_settings`
SET `leverage_mode` = 'ACCOUNT_CONFIGURED'
WHERE `execution_mode` = 'LIVE_MAINNET'
  AND `leverage_mode` = 'SYMBOL_MAX';
