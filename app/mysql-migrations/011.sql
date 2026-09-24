ALTER TABLE `raw_data` ADD COLUMN `transmission_id` VARCHAR(36) NULL;
ALTER TABLE `raw_data` ADD COLUMN `sha256` CHAR(64) NULL;
ALTER TABLE `orders` ADD COLUMN `transmission_id` VARCHAR(36) NULL;
CREATE UNIQUE INDEX `idx_raw_data_transmission_id` ON `raw_data` (`transmission_id`);
CREATE INDEX `idx_raw_data_instrument_added_on` ON `raw_data` (`instrument_id`, `added_on`);
CREATE INDEX `idx_orders_transmission_id` ON `orders` (`transmission_id`);
CREATE INDEX `idx_orders_order_id` ON `orders` (`order_id`);
