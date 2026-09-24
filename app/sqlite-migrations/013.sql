-- WHY: a result kept a copy of the whole transmission it came from, often
-- tens of kilobytes on every result. Each transmission is now kept once, in
-- raw_data, under an identifier its results carry, with a SHA-256 of its
-- bytes to show it is unchanged. A transmission stored from now on has the
-- same identifier in SQLite and MySQL, where the row ids differ.
ALTER TABLE raw_data ADD COLUMN transmission_id TEXT DEFAULT NULL;
ALTER TABLE raw_data ADD COLUMN sha256 TEXT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN transmission_id TEXT DEFAULT NULL;
CREATE UNIQUE INDEX idx_raw_data_transmission_id ON raw_data (transmission_id);
CREATE INDEX idx_raw_data_instrument_added_on ON raw_data (instrument_id, added_on);
CREATE INDEX idx_orders_transmission_id ON orders (transmission_id);
CREATE INDEX idx_orders_order_id ON orders (order_id);
