CREATE TABLE IF NOT EXISTS `binance_credentials` (
  `id` int NOT NULL DEFAULT 1,
  `exchange` varchar(16) NOT NULL DEFAULT 'BINANCE',
  `environment` varchar(16) NOT NULL DEFAULT 'MAINNET',
  `ciphertext` text NOT NULL,
  `iv` varchar(32) NOT NULL,
  `tag` varchar(32) NOT NULL,
  `key_version` int NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `binance_credentials_id` PRIMARY KEY(`id`)
);
