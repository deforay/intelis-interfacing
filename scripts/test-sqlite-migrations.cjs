const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodeSqlite = require('node:sqlite');
const { DatabaseSync } = nodeSqlite;

const migrationsDirectory = path.join(__dirname, '..', 'app', 'sqlite-migrations');

function readMigrations() {
  return fs.readdirSync(migrationsDirectory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => ({
      file,
      sql: fs.readFileSync(path.join(migrationsDirectory, file), 'utf8')
    }));
}

function splitMigrationStatements(sql) {
  const statements = [];
  let buffer = '';
  let insideTrigger = false;

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;
    if (!buffer.trim() && /^CREATE\s+TRIGGER\b/i.test(trimmed)) insideTrigger = true;
    buffer += `${line}\n`;

    if (insideTrigger) {
      if (/^END\s*;\s*$/i.test(trimmed)) {
        statements.push(buffer.trim().replace(/;\s*$/, ''));
        buffer = '';
        insideTrigger = false;
      }
      continue;
    }

    const parts = buffer.split(';');
    buffer = parts.pop() ?? '';
    statements.push(...parts.map(statement => statement.trim()).filter(Boolean));
  }

  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

function applyMigrations(database, migrations) {
  for (const migration of migrations) {
    for (const statement of splitMigrationStatements(migration.sql)) {
      database.exec(statement);
    }
  }
}

function all(database, sql, params = []) {
  // Node's built-in driver returns null-prototype rows. Normalize them so
  // assertions describe database values rather than driver object internals.
  return database.prepare(sql).all(...params).map(row => ({ ...row }));
}

function testFreshInstallation(migrations, temporaryDirectory) {
  const database = new DatabaseSync(path.join(temporaryDirectory, 'fresh.db'));
  try {
    applyMigrations(database, migrations);
    const tables = all(database, "SELECT name FROM sqlite_master WHERE type = 'table'");
    const tableNames = tables.map(row => row.name);
    assert(tableNames.includes('orders'));
    assert(tableNames.includes('raw_data'));
    assert(tableNames.includes('app_log'));
    assert(tableNames.includes('telemetry_events'));
    assert(tableNames.includes('usage_statistics_daily'));

    const orderColumns = all(database, 'PRAGMA table_info(orders)');
    const rawDataColumns = all(database, 'PRAGMA table_info(raw_data)');
    const appLogColumns = all(database, 'PRAGMA table_info(app_log)');
    const telemetryColumns = all(database, 'PRAGMA table_info(telemetry_events)');
    const dailyUsageColumns = all(database, 'PRAGMA table_info(usage_statistics_daily)');
    assert(orderColumns.some(column => column.name === 'instrument_id'));
    assert(orderColumns.some(column => column.name === 'mysql_inserted'));
    assert(orderColumns.some(column => column.name === 'notes'));
    assert(orderColumns.some(column => column.name === 'ingestion_id'));
    assert(orderColumns.some(column => column.name === 'mysql_status_synced'));
    const orderIndexes = all(database, 'PRAGMA index_list(orders)');
    assert(orderIndexes.some(index => index.name === 'idx_orders_ingestion_id' && index.unique === 1));
    assert(orderIndexes.some(index => index.name === 'idx_orders_mysql_status_pending'));
    assert(orderColumns.some(column => column.name === 'result_webhook_status' && column.notnull === 1 && column.dflt_value === '0'));
    assert(orderIndexes.some(index => index.name === 'idx_orders_result_webhook_pending'));
    assert(orderColumns.some(column => column.name === 'results_as_sent' && column.notnull === 0));
    assert(rawDataColumns.some(column => column.name === 'instrument_id'));
    assert(rawDataColumns.some(column => column.name === 'mysql_inserted'));
    assert(rawDataColumns.some(column => column.name === 'transmission_id'));
    assert(rawDataColumns.some(column => column.name === 'sha256'));
    assert(orderColumns.some(column => column.name === 'transmission_id'));
    const rawDataIndexes = all(database, 'PRAGMA index_list(raw_data)');
    assert(rawDataIndexes.some(index => index.name === 'idx_raw_data_transmission_id' && index.unique === 1));
    assert(orderIndexes.some(index => index.name === 'idx_orders_transmission_id'));
    assert(orderIndexes.some(index => index.name === 'idx_orders_order_id'));
    assert(appLogColumns.some(column => column.name === 'log_type'));
    assert(appLogColumns.some(column => column.name === 'mysql_inserted'));
    assert(appLogColumns.some(column => column.name === 'category'));
    const appLogIndexes = all(database, 'PRAGMA index_list(app_log)');
    assert(appLogIndexes.some(index => index.name === 'idx_app_log_added_on'));
    assert(telemetryColumns.some(column => column.name === 'event_id' && column.notnull === 1));
    assert(telemetryColumns.some(column => column.name === 'mysql_inserted'));
    assert(telemetryColumns.some(column => column.name === 'remote_uploaded_at'));
    assert(telemetryColumns.some(column => column.name === 'source_installation_id'));
    const telemetryIndexes = all(database, 'PRAGMA index_list(telemetry_events)');
    assert(telemetryIndexes.some(index => index.name === 'idx_telemetry_events_event_id' && index.unique === 1));
    assert(telemetryIndexes.some(index => index.name === 'idx_telemetry_events_mysql_pending'));
    assert(dailyUsageColumns.some(column => column.name === 'aggregate_id' && column.notnull === 1));
    assert(dailyUsageColumns.some(column => column.name === 'mysql_synced_revision'));

    const insertEvent = database.prepare(`
      INSERT INTO telemetry_events (
        event_id, event_type, event_category, occurred_at, source_installation_id,
        instrument_id, machine_type, test_type, outcome, event_count
      ) VALUES (?, ?, 'test', ?, 'interface-test', 'ANALYZER-1', 'cobas', 'HIVVL', ?, ?)`);
    insertEvent.run('event-1', 'test.processed', '2026-07-21 08:15:00', 'success', 1);
    insertEvent.run('event-2', 'test.processed', '2026-07-21 17:45:00', 'failed', 1);
    insertEvent.run('event-3', 'test.processing_failed', '2026-07-21 18:00:00', 'failed', 1);

    const summaries = all(database, `
      SELECT total_tests, successful_tests, failed_tests, first_test_at, last_test_at, revision
      FROM usage_statistics_daily`);
    assert.deepEqual(summaries, [{
      total_tests: 2,
      successful_tests: 1,
      failed_tests: 1,
      first_test_at: '2026-07-21 08:15:00',
      last_test_at: '2026-07-21 17:45:00',
      revision: 2
    }]);
    assert.throws(() => {
      insertEvent.run('event-2', 'test.processed', '2026-07-21 19:00:00', 'success', 1);
    }, /UNIQUE constraint failed/);
    assert.equal(all(database, 'SELECT total_tests FROM usage_statistics_daily')[0].total_tests, 2);
  } finally {
    database.close();
  }
}

function testLegacyUpgrade(migrations, temporaryDirectory) {
  const database = new DatabaseSync(path.join(temporaryDirectory, 'upgrade.db'));
  try {
    database.exec(migrations[0].sql);
    database.exec("INSERT INTO orders (order_id, test_type) VALUES ('LEGACY-001', 'HIVVL')");
    database.exec("INSERT INTO raw_data (data, machine) VALUES ('legacy payload', 'ANALYZER-OLD')");
    database.exec("INSERT INTO app_log (log) VALUES ('legacy log')");

    applyMigrations(database, migrations.slice(1));

    const orders = all(database, "SELECT order_id, mysql_inserted, mysql_status_synced, notes, ingestion_id, result_webhook_status FROM orders WHERE order_id = 'LEGACY-001'");
    const rawData = all(database, "SELECT machine, instrument_id, mysql_inserted FROM raw_data WHERE machine = 'ANALYZER-OLD'");
    const appLogs = all(database, "SELECT log, category FROM app_log WHERE log = 'legacy log'");
    assert.equal(orders.length, 1);
    assert.equal(orders[0].order_id, 'LEGACY-001');
    assert.equal(orders[0].mysql_inserted, 1);
    assert.equal(orders[0].mysql_status_synced, 1);
    assert.equal(orders[0].notes, null);
    assert.match(orders[0].ingestion_id, /^[a-f0-9]{32}$/);
    // Pending, but only sent if forwarding is turned on; first activation marks
    // everything already stored as not queued.
    assert.equal(orders[0].result_webhook_status, 0);
    assert.deepEqual(rawData, [{ machine: 'ANALYZER-OLD', instrument_id: 'ANALYZER-OLD', mysql_inserted: 0 }]);
    assert.deepEqual(appLogs, [{ log: 'legacy log', category: 'operational' }]);
    const telemetryTables = all(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_events'");
    assert.deepEqual(telemetryTables, [{ name: 'telemetry_events' }]);
    const usageTables = all(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_statistics_daily'");
    assert.deepEqual(usageTables, [{ name: 'usage_statistics_daily' }]);
  } finally {
    database.close();
  }
}

function testDailyUsageBackfill(migrations, temporaryDirectory) {
  const database = new DatabaseSync(path.join(temporaryDirectory, 'usage-backfill.db'));
  try {
    // Named rather than positional: later migrations must not move the point
    // this backfill is exercised at.
    const backfillIndex = migrations.findIndex(migration => migration.file === '010.sql');
    assert(backfillIndex > 0, 'Expected the usage statistics backfill migration');
    applyMigrations(database, migrations.slice(0, backfillIndex));
    database.exec(`
      INSERT INTO telemetry_events (
        event_id, event_type, event_category, occurred_at, instrument_id,
        machine_type, test_type, outcome, event_count
      ) VALUES
        ('backfill-1', 'test.processed', 'test', '2026-07-20 09:00:00', 'ANALYZER-2', 'cobas', 'HIVVL', 'success', 1),
        ('backfill-2', 'test.processed', 'test', '2026-07-20 10:00:00', 'ANALYZER-2', 'cobas', 'HIVVL', 'failed', 1),
        ('backfill-3', 'test.processing_failed', 'failure', '2026-07-20 11:00:00', 'ANALYZER-2', 'cobas', 'HIVVL', 'failed', 1)
    `);

    applyMigrations(database, migrations.slice(backfillIndex));

    const summaries = all(database, `
      SELECT total_tests, successful_tests, failed_tests, source_installation_id
      FROM usage_statistics_daily`);
    assert.deepEqual(summaries, [{
      total_tests: 2,
      successful_tests: 1,
      failed_tests: 1,
      source_installation_id: ''
    }]);
  } finally {
    database.close();
  }
}

async function createOnlineTestBackup(database, destination) {
  if (typeof nodeSqlite.backup === 'function') {
    await nodeSqlite.backup(database, destination);
    return;
  }

  // Node 22.12-22.15 pre-dates node:sqlite.backup. VACUUM INTO exercises the
  // same recovery contract for developers using the oldest supported runtime.
  const escapedDestination = destination.replace(/'/g, "''");
  database.exec(`VACUUM INTO '${escapedDestination}'`);
}

async function testOnlineBackupIncludesWalTransactions(temporaryDirectory) {
  const livePath = path.join(temporaryDirectory, 'wal-live.db');
  const backupPath = path.join(temporaryDirectory, 'wal-online-backup.db');
  const liveDatabase = new DatabaseSync(livePath);
  try {
    liveDatabase.exec('PRAGMA journal_mode = WAL');
    liveDatabase.exec('CREATE TABLE recovery_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    liveDatabase.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    liveDatabase.exec("INSERT INTO recovery_probe (value) VALUES ('committed-in-wal')");

    assert(fs.statSync(`${livePath}-wal`).size > 0, 'Expected a non-empty WAL sidecar');
    await createOnlineTestBackup(liveDatabase, backupPath);

    const copiedDatabase = new DatabaseSync(backupPath);
    try {
      const copiedRows = all(copiedDatabase, 'SELECT value FROM recovery_probe');
      assert.deepEqual(copiedRows, [{ value: 'committed-in-wal' }]);
      assert.deepEqual(all(copiedDatabase, 'PRAGMA quick_check'), [{ quick_check: 'ok' }]);
    } finally {
      copiedDatabase.close();
    }
  } finally {
    liveDatabase.close();
  }
}

async function main() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vlsm-migrations-'));
  try {
    const migrations = readMigrations();
    assert(migrations.length > 0, 'Expected at least one SQLite migration');
    testFreshInstallation(migrations, temporaryDirectory);
    testLegacyUpgrade(migrations, temporaryDirectory);
    testDailyUsageBackfill(migrations, temporaryDirectory);
    await testOnlineBackupIncludesWalTransactions(temporaryDirectory);
    console.log(`SQLite migration tests passed (${migrations.length} migrations).`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
