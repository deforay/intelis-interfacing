-- WHY: a laboratory's result rules can store a value other than the one the
-- analyzer sent ("> Titer max" as "> 10000000"). The value as sent is kept
-- beside it on every new result. NULL on results stored before this column.
ALTER TABLE orders ADD COLUMN results_as_sent TEXT DEFAULT NULL;
