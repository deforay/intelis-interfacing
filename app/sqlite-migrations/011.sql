-- WHY: the result webhook keeps its own delivery state. Sharing
-- lims_sync_status with InteLIS delivery would let either sender mark a result
-- as done for the other. 0 pending, 1 delivered, 2 not queued (received before
-- the forwarding settings were first saved).
ALTER TABLE orders ADD COLUMN result_webhook_status INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_orders_result_webhook_pending
  ON orders (result_webhook_status, id);
