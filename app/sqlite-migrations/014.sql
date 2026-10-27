-- WHY: result_status keeps only "final or not", and every HL7 result was
-- stored as final. The console shows the analyzer's own status, so the
-- letter it sent is kept: ASTM O.26 or HL7 OBX.11.
ALTER TABLE orders ADD COLUMN result_status_as_sent TEXT DEFAULT NULL;
