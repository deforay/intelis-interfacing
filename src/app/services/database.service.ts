import { Injectable, } from '@angular/core';
import { ElectronService } from '../core/services';
import { ElectronStoreService } from './electron-store.service';
import { CryptoService } from './crypto.service'
import { LoggingService } from './logging.service';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { TelemetryEventInput } from '../interfaces/telemetry-event.interface';
import { RawDataFilter, RawDataStore } from '../interfaces/raw-machine-data.interface';
import { transmissionSha256 } from './transmission-fingerprint';
import { formatInTimeZone } from '../../../shared/time-zone';
import {
  IntelisActivityEvent,
  IntelisResultAcknowledgement,
  IntelisResultRow,
  IntelisUsageSummary,
  IntelisUsageSummaryAcknowledgement
} from '../../../shared/intelis-connection';
import {
  RESULT_WEBHOOK_RESULT_FIELDS,
  RESULT_WEBHOOK_STATUS,
  ResultWebhookResult,
  toResultWebhookResult
} from '../../../shared/result-webhook';

export interface ApplicationLogStoreCleanupPreview {
  available: boolean;
  totalRows: number;
  deletableRows: number;
  activeDays: number;
  cutoffDate: string | null;
  oldestDate: string | null;
  newestDate: string | null;
}

export interface ApplicationLogCleanupPreview {
  retainedActiveDays: number;
  local: ApplicationLogStoreCleanupPreview;
  mysql: ApplicationLogStoreCleanupPreview;
}

/** How much space results and raw data take in one database. */
/** Which unlinked results the background compaction may change. */
export interface SettledResults {
  /** Only results stored before this time, as stored. */
  storedBefore: string;
  /** Also require the result webhook to have delivered it (SQLite only). */
  webhookDelivered: boolean;
}

export interface StoreUsage {
  available: boolean;
  results: number;
  /** Bytes of raw text kept on results */
  resultTextBytes: number;
  /** Results that carry the identifier of the transmission they came from */
  linkedResults: number;
  transmissions: number;
  transmissionBytes: number;
  /** Size of the database file, SQLite only */
  fileBytes: number | null;
}

/** A stored transmission, as read for display or reprocessing. */
export interface StoredTransmission {
  id: number;
  store: RawDataStore;
  data: string;
  machine: string;
  instrument_id: string | null;
  added_on: any;
  transmission_id: string | null;
  sha256: string | null;
}

export interface ApplicationLogCleanupResult {
  localDeletedRows: number;
  mysqlDeletedRows: number;
  mysqlAvailable: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class DatabaseService {

  private mysqlPool = null;
  private dbConfig = null;
  private commonSettings = null;
  private migrationDir: string; // Path for migrations
  private hasRunMigrations = false;
  // Silent MySQL repairs this session, and the one in progress.
  private migrationAutoRetryCount = 0;
  private mysqlReplay: Promise<boolean> | null = null;
  // Once a restart has been asked for in this session, it is not asked for
  // again: the app is restarting, and many queries can fail in quick succession.
  private restartRequested = false;
  private readonly restartRequiredSubject = new BehaviorSubject<boolean>(false);
  /** True once the database needs a restart to finish updating. */
  readonly restartRequired$ = this.restartRequiredSubject.asObservable();
  // Silent SQLite repairs this session. Two is enough: a third would mean the
  // migrations themselves cannot add what the code needs.
  private sqliteReplayCount = 0;
  private sqliteReplay: Promise<boolean> | null = null;
  // When the last database repair restarted the app, set by the main process.
  // A schema error soon after one means the repair did not fix it, and
  // restarting again would loop.
  private static readonly DATABASE_REPAIR_KEY = 'databaseRepairStartedAt';
  private static readonly REPAIR_LOOP_WINDOW_MS = 10 * 60 * 1000;
  private static readonly DDL_ERROR_CODES = new Set(['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_NO_SUCH_COLUMN']);
  private static readonly DDL_ERROR_PATTERNS = [
    /unknown column/i,
    /table .+ doesn't exist/i,
    /column .+ (cannot be null|doesn't have a default)/i,
  ];
  // SQLite errors look different from MySQL — `no such table: orders`,
  // `no such column: x`, `table orders has no column named x`.
  private static readonly SQLITE_DDL_ERROR_PATTERNS = [
    /no such table/i,
    /no such column/i,
    /has no column named/i,
  ];
  private static readonly MIGRATION_REPLAY_ERROR_CODES = new Set([
    'ER_TABLE_EXISTS_ERROR',
    'ER_CANT_DROP_FIELD_OR_KEY',
    'ER_DUP_FIELDNAME',
    'ER_DUP_ENTRY',
    'ER_DUP_INDEX',
    'ER_DUP_KEYNAME',
    'ER_DUP_UNIQUE',
    'ER_FK_COLUMN_CANNOT_DROP',
    'ER_FK_COLUMN_CANNOT_DROP_CHILD',
    'ER_FK_COLUMN_CANNOT_DROP_PARENT',
    'ER_TABLESPACE_EXISTS',
    'ER_MULTIPLE_PRI_KEY',
  ]);
  private static readonly MIGRATION_REPLAY_ERROR_PATTERNS = [
    /already exists/i,
    /can't drop .+ check that .+ exists/i,
    /cannot drop .+ needed in a foreign key constraint/i,
    /cannot drop index .+ needed in a foreign key constraint/i,
    /duplicate/i,
    /duplicate column name/i,
    /duplicate entry/i,
    /duplicate foreign key constraint name/i,
    /duplicate index/i,
    /duplicate key name/i,
    /duplicate unique/i,
    /foreign key constraint .+ already exists/i,
    /multiple primary key defined/i,
  ];
  private static readonly MYSQL_APP_LOG_RESYNC_BATCH_SIZE = 25;
  private static readonly MYSQL_ORDER_RESYNC_BATCH_SIZE = 25;
  private static readonly MYSQL_TELEMETRY_RESYNC_LIMIT = 500;
  private static readonly MYSQL_USAGE_STATISTICS_RESYNC_LIMIT = 500;
  private static readonly SQLITE_LOG_INSERT_BATCH_SIZE = 100;
  private static readonly LOCAL_LOG_RETENTION_ACTIVE_DAYS = 30;
  public static readonly MINIMUM_LOG_RETENTION_ACTIVE_DAYS = 7;
  private static readonly LOCAL_LOG_MAX_ROWS = 50000;
  private static readonly LOCAL_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  private static readonly MYSQL_ORDER_COLUMNS = [
    'instrument_id',
    'order_id',
    'test_id',
    'test_type',
    'created_date',
    'test_unit',
    'results',
    'results_as_sent',
    'tested_by',
    'analysed_date_time',
    'specimen_date_time',
    'authorised_date_time',
    'result_accepted_date_time',
    'machine_used',
    'test_location',
    'created_at',
    'result_status',
    'result_status_as_sent',
    'lims_sync_status',
    'lims_sync_date_time',
    'repeated',
    'test_description',
    'is_printed',
    'printed_at',
    'raw_text',
    'added_on',
    'notes',
    'ingestion_id',
    'transmission_id',
  ];
  private static readonly SQLITE_ORDER_COLUMNS = [
    ...DatabaseService.MYSQL_ORDER_COLUMNS,
    'mysql_inserted',
  ];
  private static readonly MYSQL_RAW_DATA_COLUMNS = [
    'data',
    'machine',
    'added_on',
    'instrument_id',
    'transmission_id',
    'sha256',
  ];
  private static readonly SQLITE_RAW_DATA_COLUMNS = [
    ...DatabaseService.MYSQL_RAW_DATA_COLUMNS,
    'mysql_inserted',
  ];
  private static readonly MYSQL_TELEMETRY_COLUMNS = [
    'event_id',
    'event_type',
    'event_category',
    'occurred_at',
    'lab_id',
    'source_installation_id',
    'instrument_id',
    'machine_type',
    'protocol',
    'connection_mode',
    'test_type',
    'outcome',
    'failure_code',
    'event_count',
    'app_version',
    'remote_uploaded_at',
    'remote_batch_id',
    'added_on',
  ];
  private static readonly SQLITE_TELEMETRY_COLUMNS = [
    ...DatabaseService.MYSQL_TELEMETRY_COLUMNS,
    'mysql_inserted',
  ];
  private static readonly MYSQL_USAGE_STATISTICS_COLUMNS = [
    'aggregate_id',
    'activity_date',
    'source_installation_id',
    'lab_id',
    'instrument_id',
    'machine_type',
    'test_type',
    'total_tests',
    'successful_tests',
    'failed_tests',
    'first_test_at',
    'last_test_at',
    'revision',
    'updated_at',
  ];
  private readonly path: any = (window as any).require('path');
  private lastLocalLogPruneAt = 0;
  private readonly resultRecordedSubject = new Subject<void>();
  public readonly resultRecorded$ = this.resultRecordedSubject.asObservable();
  private readonly usageRecordedSubject = new Subject<void>();
  public readonly usageRecorded$ = this.usageRecordedSubject.asObservable();

  constructor(private readonly electronService: ElectronService,
    private readonly store: ElectronStoreService,
    private readonly cryptoService: CryptoService,
    private readonly loggingService: LoggingService
  ) {
    this.store.electronStoreObservable().subscribe(config => {
      this.commonSettings = config.commonConfig;
      this.init().catch(err => console.error('Database service initialization failed:', err));
    });
  }


  private async init() {
    console.log('Initializing database service...');
    const mysql = this.electronService.mysql;

    // Fetch the userData path from Electron
    const userDataPath = await this.electronService.getUserDataPath();
    this.migrationDir = this.path.join(userDataPath, 'mysql-migrations');
    //console.log('User Data Path:', userDataPath);

    // Ensure mysqlPool and dbConfig are not initialized multiple times
    if (!this.mysqlPool && this.commonSettings?.mysqlHost && this.commonSettings?.mysqlUser && this.commonSettings?.mysqlDb) {

      this.dbConfig = {
        connectionLimit: 10,
        waitForConnections: true,
        queueLimit: 0,
        connectTimeout: 10000,
        enableKeepAlive: true,
        host: this.commonSettings.mysqlHost,
        user: this.commonSettings.mysqlUser,
        password: this.cryptoService.decrypt(this.commonSettings.mysqlPassword),
        database: this.commonSettings.mysqlDb,
        port: this.commonSettings.mysqlPort,
        dateStrings: 'date'
      };

      this.mysqlPool = mysql.createPool(this.dbConfig);

      console.log('MySQL pool created, waiting for connection...');

      await this.setupDatabase();

      this.mysqlPool.on('error', (err) => {
        this.logCriticalDatabaseIssue(`MySQL pool error: ${err?.message ?? err}`);
        console.error('MySQL pool error:', err);
      });

    } else {
      //console.warn('MySQL Pool or configuration is already initialized or incomplete.');
    }
  }


  private async setupDatabase(): Promise<void> {
    await this.checkAndRunMigrations(null);
    await this.execQueryPromise("SET SESSION sql_mode=(SELECT REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', ''))", []);
    await this.execQueryPromise("SET SESSION INTERACTIVE_TIMEOUT=600", []);
    await this.execQueryPromise("SET SESSION WAIT_TIMEOUT=600", []);
    this.resyncTelemetryToMySQL(() => { }, () => { });
  }

  public sqlite3WalCheckpoint(): void {

    // Run a checkpoint to merge WAL file changes back into the main database file
    // This helps prevent the WAL file from growing too large
    this.electronService.executeSqliteWalCheckpoint()
      .then((result) => {
        console.log('SQLite WAL checkpoint completed successfully:', result);
      })
      .catch((error) => {
        console.error('Error running SQLite WAL checkpoint:', error);
      });
  }

  public checkMysqlConnection(
    mysqlParams?: { host?: string, user?: string, password?: string, port?: string },
    successCallback?: Function,
    errorCallback?: Function
  ): void {
    const mysql = this.electronService.mysql;

    const connection = mysql.createConnection({
      host: mysqlParams?.host ?? this.commonSettings.mysqlHost,
      user: mysqlParams?.user ?? this.commonSettings.mysqlUser,
      password: this.cryptoService.decrypt(mysqlParams?.password ?? this.commonSettings.mysqlPassword),
      port: mysqlParams?.port ?? this.commonSettings.mysqlPort
    });

    connection.connect((err: any) => {
      if (err) {
        if (errorCallback) errorCallback(err); // Check if errorCallback exists
      } else {
        if (successCallback) successCallback(); // Check if successCallback exists
        connection.destroy();
      }
    });
  }

  /**
   * Checks if migrations have been run and executes them if not.
   * This method is called automatically when the MySQL connection is established.
   */
  private async checkAndRunMigrations(connection, replayAll = false) {
    const forceReplay = await this.isForceMigrationReplayRequested();

    if (this.hasRunMigrations && !forceReplay) {
      console.log('Migrations already run, skipping...');
      return;
    }
    console.log('🚀 Starting MySQL migrations...');
    console.log('Target database:', this.commonSettings.mysqlDb);
    console.log('Migration directory:', this.migrationDir);
    if (forceReplay) {
      console.log('MySQL force replay requested; every migration file will be attempted');
    }

    try {
      // STEP 1: Ensure database exists using a temporary connection (without database parameter)
      console.log('Step 1: Ensuring database exists...');
      try {
        await new Promise<void>((resolve, reject) => {
          const mysql = this.electronService.mysql;
          const tempConnection = mysql.createConnection({
            host: this.commonSettings.mysqlHost,
            user: this.commonSettings.mysqlUser,
            password: this.cryptoService.decrypt(this.commonSettings.mysqlPassword),
            port: this.commonSettings.mysqlPort
          });
          tempConnection.query(
            `CREATE DATABASE IF NOT EXISTS \`${this.commonSettings.mysqlDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
            (err) => {
              tempConnection.destroy();
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });
        console.log('✅ Database ensured:', this.commonSettings.mysqlDb);
      } catch (createDbError) {
        console.log('ℹ️ Database creation note:', createDbError.message);
        // Continue - database likely already exists, pool will connect to it
      }

      // STEP 2: Check migration directory
      console.log('Step 3: Checking migration directory...');
      if (!this.electronService.fs.existsSync(this.migrationDir)) {
        console.log('ℹ️ Migration directory not found:', this.migrationDir);
        console.log('✅ No migrations to run - continuing...');
        return;
      }

      console.log('✅ Migration directory exists');

      // STEP 4: Get migration files
      const migrationFiles = this.electronService.fs.readdirSync(this.migrationDir)
        .filter(file => file.endsWith('.sql'))
        .sort(); // Sorts alphabetically: 001.sql, 002.sql, 003.sql

      console.log(`Found ${migrationFiles.length} migration files:`, migrationFiles);

      if (migrationFiles.length === 0) {
        console.log('✅ No migration files found - migrations complete');
        return;
      }

      // STEP 5: Create versions tracking table
      console.log('Step 4: Setting up migration tracking...');
      const createVersionsTable = `
      CREATE TABLE IF NOT EXISTS versions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version INT NOT NULL UNIQUE,
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_version (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;

      await this.execMigrationQuery(createVersionsTable, []);
      console.log('✅ Versions tracking table ready');

      // STEP 6: Get already executed migrations — self-healing: if versions table is stale/corrupt, reset it
      let executedResults: any[];
      try {
        if (forceReplay) {
          await this.execMigrationQuery('DELETE FROM versions', []);
          executedResults = [];
          console.log('✅ MySQL versions table cleared for force replay');
        } else {
          executedResults = await this.execMigrationQuery('SELECT version, filename FROM versions ORDER BY version', []);
        }
      } catch (versionsQueryErr) {
        console.warn('⚠️ Versions table query failed, resetting migration tracking:', versionsQueryErr.message);
        await this.execMigrationQuery('DROP TABLE IF EXISTS versions', []);
        await this.execMigrationQuery(createVersionsTable, []);
        executedResults = [];
        console.log('✅ Versions table reset — all migrations will re-run');
      }
      const executedVersions = executedResults.map((row: any) => row.version);
      console.log('Previously executed versions:', executedVersions);

      let hadUnexpectedFailures = false;
      try {
        await this.ensureMysqlSchemaCompatibility();
      } catch (compatibilityErr) {
        // WHY: the migration files below can still create what is missing, so
        // a failed column repair must not stop them from running.
        hadUnexpectedFailures = true;
        this.logCriticalDatabaseIssue(`MySQL column repair failed before migrations: ${compatibilityErr?.message ?? compatibilityErr}`, 'migration');
      }

      // STEP 7: Identify pending migrations
      const migrations = migrationFiles
        .map(file => ({
          version: Number.parseInt(file.replace('.sql', ''), 10),
          file: file
        }))
        .filter(migration => {
          if (Number.isNaN(migration.version)) {
            console.warn(`⚠️ Skipping file with invalid version number: ${migration.file}`);
            return false;
          }
          // WHY: a missing table means the history in `versions` is wrong, so
          // a repair replays every file. Each one is safe to run again.
          return replayAll || !executedVersions.includes(migration.version);
        })
        .sort((a, b) => a.version - b.version);

      if (migrations.length === 0) {
        console.log('✅ All migrations already executed');
        this.hasRunMigrations = !hadUnexpectedFailures;
        if (!hadUnexpectedFailures) {
          await this.clearForceMigrationReplayRequest(forceReplay);
        }
        return;
      }

      console.log(`Step 5: Executing ${migrations.length} pending migrations...`);

      // Execute migrations sequentially.
      // WHY: re-runs should tolerate idempotent DDL conflicts, but they must not
      // mark a migration successful when a real statement failed.
      let successCount = 0;

      for (const migration of migrations) {
        console.log(`\n--- Executing Migration ${migration.version}: ${migration.file} ---`);

        try {
          const migrationPath = this.path.join(this.migrationDir, migration.file);

          if (!this.electronService.fs.existsSync(migrationPath)) {
            console.log(`ℹ️ Migration file not found, skipping: ${migrationPath}`);
            continue;
          }

          const migrationSql = this.electronService.fs.readFileSync(migrationPath, 'utf8');
          console.log(`📄 Migration size: ${migrationSql.length} characters`);

          const statements = this.extractMigrationStatements(migrationSql);

          console.log(`🔧 Processing ${statements.length} SQL statements...`);

          let migrationHadUnexpectedFailures = false;

          // Permissive mode: log unexpected errors but keep going so one bad
          // statement can't block later repair statements in the same file.
          for (let i = 0; i < statements.length; i++) {
            const statement = statements[i];
            try {
              await this.execMigrationQuery(statement, []);
            } catch (stmtErr) {
              if (this.isExpectedMigrationReplayError(stmtErr)) {
                console.warn(`ℹ️ Migration replay note for ${migration.file}: ${stmtErr.message}`);
                continue;
              }

              hadUnexpectedFailures = true;
              migrationHadUnexpectedFailures = true;
              this.logCriticalDatabaseIssue(`Migration ${migration.file} statement ${i + 1} failed (continuing): ${stmtErr.message}`, 'migration');
              console.error(`❌ Migration ${migration.file} statement ${i + 1} failed (continuing):`, stmtErr.message);
            }
          }

          if (migrationHadUnexpectedFailures) {
            console.error(`❌ Migration ${migration.file} had unexpected failures; leaving it pending for retry`);
            continue;
          }

          // Record migration as completed
          try {
            await this.execMigrationQuery(
              'INSERT INTO versions (version, filename) VALUES (?, ?)',
              [migration.version, migration.file]
            );
          } catch (versionErr) {
            if (!this.isExpectedMigrationReplayError(versionErr)) {
              hadUnexpectedFailures = true;
              this.logCriticalDatabaseIssue(`Failed to record migration ${migration.file}: ${versionErr.message}`, 'migration');
              console.error(`❌ Failed to record migration ${migration.file}:`, versionErr.message);
              continue;
            }
          }

          console.log(`✅ Migration ${migration.file} completed (${statements.length} statements)`);
          successCount++;

        } catch (err) {
          hadUnexpectedFailures = true;
          this.logCriticalDatabaseIssue(`Migration ${migration.file} skipped: ${err.message}`, 'migration');
          console.log(`ℹ️ Migration ${migration.file} skipped: ${err.message}`);
        }
      }

      // Final summary
      await this.ensureMysqlSchemaCompatibility();
      console.log(`\n🎯 Migration Summary: ${successCount}/${migrations.length} processed`);
      this.hasRunMigrations = !hadUnexpectedFailures;
      if (hadUnexpectedFailures) {
        console.warn('⚠️ MySQL migrations completed with unexpected failures. Pending migrations will retry later.');
      } else {
        await this.clearForceMigrationReplayRequest(forceReplay);
      }

    } catch (error) {
      // Permissive mode - log and continue, but don't set hasRunMigrations so retry is possible
      console.log('ℹ️ Migration process completed with some skipped items:', error);
    }
  }

  private async isForceMigrationReplayRequested(): Promise<boolean> {
    try {
      return await this.electronService.isForceMigrationReplayRequested();
    } catch (err) {
      console.warn('Could not read force migration replay flag:', err);
      return false;
    }
  }

  private async clearForceMigrationReplayRequest(wasForceReplay: boolean): Promise<void> {
    if (!wasForceReplay) {
      return;
    }

    try {
      await this.electronService.clearForceMigrationReplayRequest();
    } catch (err) {
      console.warn('Could not clear force migration replay flag:', err);
    }
  }

  private async ensureMysqlSchemaCompatibility(): Promise<void> {
    await this.ensureMysqlColumn('app_log', 'log_type', 'ALTER TABLE `app_log` ADD COLUMN `log_type` VARCHAR(20) NULL');
    await this.ensureMysqlColumn('app_log', 'log_message', 'ALTER TABLE `app_log` ADD COLUMN `log_message` TEXT NULL');
    await this.ensureMysqlColumn('app_log', 'instrument_id', 'ALTER TABLE `app_log` ADD COLUMN `instrument_id` VARCHAR(255) NULL');
    await this.ensureMysqlColumn('app_log', 'category', "ALTER TABLE `app_log` ADD COLUMN `category` VARCHAR(20) NOT NULL DEFAULT 'operational'");
    await this.ensureMysqlColumn('raw_data', 'instrument_id', 'ALTER TABLE `raw_data` ADD COLUMN `instrument_id` VARCHAR(128) NULL');
    await this.ensureMysqlColumn('orders', 'instrument_id', 'ALTER TABLE `orders` ADD COLUMN `instrument_id` VARCHAR(128) NULL');
    await this.ensureMysqlColumn('orders', 'notes', 'ALTER TABLE `orders` ADD COLUMN `notes` TEXT NULL');
    await this.ensureMysqlColumn('orders', 'results_as_sent', 'ALTER TABLE `orders` ADD COLUMN `results_as_sent` VARCHAR(255) NULL AFTER `results`');
    await this.ensureMysqlColumn('orders', 'ingestion_id', 'ALTER TABLE `orders` ADD COLUMN `ingestion_id` VARCHAR(36) NULL');
    await this.ensureMysqlIndex('orders', 'idx_orders_ingestion_id', 'CREATE UNIQUE INDEX `idx_orders_ingestion_id` ON `orders` (`ingestion_id`)');
    await this.ensureMysqlColumn('orders', 'result_status_as_sent', 'ALTER TABLE `orders` ADD COLUMN `result_status_as_sent` VARCHAR(10) NULL');
    await this.ensureMysqlColumn('orders', 'transmission_id', 'ALTER TABLE `orders` ADD COLUMN `transmission_id` VARCHAR(36) NULL');
    await this.ensureMysqlColumn('raw_data', 'transmission_id', 'ALTER TABLE `raw_data` ADD COLUMN `transmission_id` VARCHAR(36) NULL');
    await this.ensureMysqlColumn('raw_data', 'sha256', 'ALTER TABLE `raw_data` ADD COLUMN `sha256` CHAR(64) NULL');
    await this.ensureMysqlIndex('raw_data', 'idx_raw_data_transmission_id', 'CREATE UNIQUE INDEX `idx_raw_data_transmission_id` ON `raw_data` (`transmission_id`)');
  }

  private async ensureMysqlColumn(tableName: string, columnName: string, alterSql: string): Promise<void> {
    const tableExists = await this.mysqlTableExists(tableName);
    if (!tableExists) {
      return;
    }

    const columnExists = await this.mysqlColumnExists(tableName, columnName);
    if (columnExists) {
      return;
    }

    // WHY: older installations can have stale migration history that says a
    // migration ran even though a later column in that file was never added.
    console.warn(`Repairing missing MySQL column ${tableName}.${columnName}`);
    await this.execRepairStatement(alterSql);
  }

  private async mysqlTableExists(tableName: string): Promise<boolean> {
    const rows = await this.execMigrationQuery(
      'SELECT COUNT(*) AS table_count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [this.commonSettings.mysqlDb, tableName]
    );
    return Number(rows?.[0]?.table_count ?? 0) > 0;
  }

  private async mysqlColumnExists(tableName: string, columnName: string): Promise<boolean> {
    const rows = await this.execMigrationQuery(
      'SELECT COUNT(*) AS column_count FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [this.commonSettings.mysqlDb, tableName, columnName]
    );
    return Number(rows?.[0]?.column_count ?? 0) > 0;
  }

  private async ensureMysqlIndex(tableName: string, indexName: string, createSql: string): Promise<void> {
    const tableExists = await this.mysqlTableExists(tableName);
    if (!tableExists) {
      return;
    }

    const rows = await this.execMigrationQuery(
      'SELECT COUNT(*) AS index_count FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [this.commonSettings.mysqlDb, tableName, indexName]
    );
    if (Number(rows?.[0]?.index_count ?? 0) > 0) {
      return;
    }

    // WHY: retry safety depends on the database enforcing ingestion identity,
    // including installations whose migration history is incomplete.
    console.warn(`Repairing missing MySQL index ${tableName}.${indexName}`);
    await this.execRepairStatement(createSql);
  }

  private async execRepairStatement(sql: string): Promise<void> {
    try {
      await this.execMigrationQuery(sql, []);
    } catch (err) {
      // WHY: another repair or a migration can add the same column or index
      // between the check and this statement. It is there, which is the goal.
      if (!this.isExpectedMigrationReplayError(err)) {
        throw err;
      }
    }
  }

  private filterRecordColumns(record: any, allowedColumns: readonly string[]): any {
    const filteredRecord: any = {};

    allowedColumns.forEach((columnName) => {
      if (Object.hasOwn(record, columnName)) {
        filteredRecord[columnName] = record[columnName];
      }
    });

    return filteredRecord;
  }

  private buildInsertQuery(tableName: string, record: any): { query: string; values: any[] } {
    const columns = Object.keys(record);
    const placeholders = columns.map(() => '?').join(',');
    const escapedColumns = columns.map(columnName => `\`${columnName}\``).join(',');

    return {
      query: `INSERT INTO \`${tableName}\` (${escapedColumns}) VALUES (${placeholders})`,
      values: Object.values(record),
    };
  }

  private extractMigrationStatements(sql: string): string[] {
    return sql
      .replace(/\/\*[\s\S]*?\*\//g, '\n')
      .split('\n')
      .filter(line => {
        const trimmedLine = line.trim();
        return trimmedLine.length > 0
          && !trimmedLine.startsWith('--')
          && !trimmedLine.startsWith('//');
      })
      .join('\n')
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0)
      .filter(stmt => stmt.toLowerCase() !== 'delimiter');
  }

  private isExpectedMigrationReplayError(error: any): boolean {
    return DatabaseService.MIGRATION_REPLAY_ERROR_CODES.has(error?.code)
      || DatabaseService.MIGRATION_REPLAY_ERROR_PATTERNS.some(pattern => pattern.test(error?.message ?? ''));
  }

  /**
   * Debug method to check migration system status
   */
  public debugMigrationSystem(): void {

    console.log('\n=== 🔍 MIGRATION DEBUG INFO ===');
    console.log('Migration directory:', this.migrationDir);
    console.log('Directory exists:', this.electronService.fs.existsSync(this.migrationDir));

    if (this.electronService.fs.existsSync(this.migrationDir)) {
      const files = this.electronService.fs.readdirSync(this.migrationDir);
      console.log('All files in directory:', files);

      const sqlFiles = files.filter(f => f.endsWith('.sql'));
      console.log('SQL migration files:', sqlFiles);

      // Show file sizes
      sqlFiles.forEach(file => {
        const filePath = this.path.join(this.migrationDir, file);
        const stats = this.electronService.fs.statSync(filePath);
        console.log(`  ${file}: ${stats.size} bytes`);
      });
    }

    console.log('\nDatabase configuration:');
    console.log('- Host:', this.commonSettings?.mysqlHost);
    console.log('- User:', this.commonSettings?.mysqlUser);
    console.log('- Database:', this.commonSettings?.mysqlDb);
    console.log('- Port:', this.commonSettings?.mysqlPort);
    console.log('- Pool initialized:', !!this.mysqlPool);
    console.log('- Migrations run flag:', this.hasRunMigrations);

    // Test MySQL connection
    console.log('\n🔌 Testing MySQL connection...');
    this.checkMysqlConnection(null,
      () => {
        console.log('✅ MySQL connection: SUCCESS');

        // Check if versions table exists
        this.execQuery('SHOW TABLES LIKE "versions"', [],
          (results) => {
            if (results.length > 0) {
              console.log('✅ Versions table: EXISTS');

              // Show executed migrations
              this.execQuery('SELECT * FROM versions ORDER BY version', [],
                (versions) => {
                  console.log('📋 Executed migrations:', versions);
                },
                (err) => console.log('❌ Error reading versions:', err.message)
              );
            } else {
              console.log('ℹ️ Versions table: NOT FOUND (will be created during migrations)');
            }
          },
          (err) => console.log('ℹ️ Cannot check versions table:', err.message)
        );
      },
      (err) => console.log('❌ MySQL connection: FAILED -', err.message)
    );
  }

  // Helper method to convert execQuery to Promise-based:
  private execQueryPromise(query: string, data: any[], repairOnSchemaError = true): Promise<any> {
    return new Promise((resolve, reject) => {
      this.execQuery(query, data, resolve, reject, null, repairOnSchemaError);
    });
  }

  /**
   * Runs a statement for the migrations or the schema repair. A schema error
   * here must not start a repair, since the repair would wait on itself.
   */
  private execMigrationQuery(query: string, data: any[]): Promise<any> {
    return this.execQueryPromise(query, data, false);
  }

  private logCriticalDatabaseIssue(
    message: string,
    category: 'database' | 'migration' = 'database',
    instrumentId: string | null = null,
    displayInConsole = true
  ): void {
    this.loggingService.log('error', message, instrumentId, {
      category,
      displayInConsole
    });
  }

  private isSqliteDdlError(err: any): boolean {
    const message = (err?.message ?? '').toString();
    return DatabaseService.SQLITE_DDL_ERROR_PATTERNS.some(pattern => pattern.test(message));
  }

  /**
   * Called when a query still fails because the database structure is behind
   * the code, after the silent repair has had its chance. The app does not
   * work properly like that, so it restarts to apply every update before any
   * instrument connects: RestartNoticeComponent counts down and restarts. The
   * error goes to the log, not on screen.
   *
   * If the last restart for this reason was minutes ago, it did not fix the
   * problem, and restarting again would loop. The operator is sent to support
   * instead.
   */
  private async requestRestartForDatabaseUpdate(source: 'MySQL' | 'SQLite', error: any): Promise<void> {
    if (this.restartRequested) {
      return;
    }
    this.restartRequested = true;
    this.logCriticalDatabaseIssue(`${source} database structure is out of date; restart required: ${error?.message ?? error}`, 'migration');

    const lastRepair = Number(this.store.get(DatabaseService.DATABASE_REPAIR_KEY)) || 0;
    if (Date.now() - lastRepair >= DatabaseService.REPAIR_LOOP_WINDOW_MS) {
      this.restartRequiredSubject.next(true);
      return;
    }

    try {
      await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
        type: 'error',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Database Needs Attention',
        message: 'The Interface Tool could not finish updating its database.',
        detail: `A restart did not fix it. Contact support and send them the log files. To find them, press Open Logs Folder in Settings, under Troubleshooting.\n\nDetails: ${error?.message ?? error}`
      });
    } catch (dialogErr) {
      console.error('Failed to show the database notice:', dialogErr);
    }
  }

  /**
   * Re-applies every SQLite migration on the open database, without a
   * restart. Resolves true when all of them applied. Queries that fail at the
   * same moment share one replay.
   */
  private replaySqliteMigrationsSilently(): Promise<boolean> {
    if (this.sqliteReplay !== null) {
      return this.sqliteReplay;
    }
    if (this.sqliteReplayCount >= 2) {
      return Promise.resolve(false);
    }
    this.sqliteReplayCount++;
    this.sqliteReplay = this.electronService.ipcRenderer.invoke('replay-sqlite-migrations')
      .then((result: any) => result?.ok === true)
      .catch((err: any) => {
        console.error('Silent SQLite repair failed:', err);
        return false;
      })
      .finally(() => {
        this.sqliteReplay = null;
      });
    return this.sqliteReplay;
  }

  /**
   * Re-applies every database update and restarts the app. Used by the
   * restart notice and by Repair Database in Settings.
   *
   * The restart always happens: the app does not work properly on a database
   * that is behind its code. force-rerun-migrations clears SQLite's history
   * and sets a replay flag. The flag makes the next MySQL connection clear
   * MySQL's history too, and stays set until that replay succeeds, so an
   * unreachable MySQL server is replayed once it is back.
   */
  public async performForceRerunMigrations(): Promise<void> {
    await this.electronService.ipcRenderer.invoke('force-rerun-migrations');
  }

  /**
   * Wrapper around ElectronService.execSqliteQuery that repairs SQLite schema
   * drift (a missing table or column). It re-applies the migrations without a
   * restart and runs the query again, so the query that found the drift still
   * succeeds. A statement that failed on a missing table or column did not
   * run, so running it again cannot apply it twice. If the repair does not
   * fix it, the app restarts. All renderer-side SQLite traffic should go
   * through this so schema drift is handled the same way for both databases.
   */
  private execSqlite(sql: string, params: any[] = [], repairOnSchemaError = true): Promise<any> {
    return this.electronService.execSqliteQuery(sql, params).catch(async (err: any) => {
      if (!this.isSqliteDdlError(err)) {
        throw err;
      }
      this.logCriticalDatabaseIssue(`SQLite DDL error: ${err?.message ?? err}`, 'database', null, false);
      if (repairOnSchemaError && await this.replaySqliteMigrationsSilently()) {
        return this.execSqlite(sql, params, false);
      }
      void this.requestRestartForDatabaseUpdate('SQLite', err);
      throw err;
    });
  }

  execQuery(query: string, data: any, success: any, errorf: any, callback = null, repairOnSchemaError = true) {
    if (!this.mysqlPool) {
      errorf({ error: 'Database Connection not found' });
      return;
    }

    this.mysqlPool.getConnection((err, connection) => {
      if (err) {
        errorf(err);
        return;
      }

      connection.query({ sql: query }, data, (queryError, results) => {
        if (queryError) {
          connection.release();
          if (repairOnSchemaError && this.isMysqlDdlError(queryError)) {
            this.repairMysqlSchemaAndRetryQuery(queryError, query, data, success, errorf, callback);
            return;
          }
          errorf(queryError);
          return;
        }

        // If a callback is provided, use it and let it handle the connection release
        if (callback) {
          callback(results, error => {
            connection.release();
            if (error) {
              errorf(error);
            } else {
              success(results);
            }
          });
        } else {
          // If no callback, handle success and release the connection
          success(results);
          connection.release();
        }
      });
    });
  }

  private isMysqlDdlError(error: any): boolean {
    return DatabaseService.DDL_ERROR_CODES.has(error?.code)
      || DatabaseService.DDL_ERROR_PATTERNS.some(pattern => pattern.test(error?.message ?? ''));
  }

  /**
   * Replays every MySQL migration on the live database, then runs the query
   * that found the drift again. Only if it still fails does the app ask for a
   * restart. Mirrors the SQLite repair in execSqlite.
   */
  private repairMysqlSchemaAndRetryQuery(queryError: any, query: string, data: any, success: any, errorf: any, callback: any): void {
    this.logCriticalDatabaseIssue(`MySQL DDL error; repairing schema before retry. Query: ${query} | Error: ${queryError?.message ?? queryError}`, 'migration', null, false);
    const failAfterRepair = (error: any) => {
      if (this.isMysqlDdlError(error)) {
        void this.requestRestartForDatabaseUpdate('MySQL', error);
      }
      errorf(error);
    };
    void this.replayMysqlMigrationsSilently().then((repaired) => {
      if (!repaired) {
        this.logCriticalDatabaseIssue(`MySQL schema repair did not finish. Retrying query: ${query}`, 'migration', null, false);
      }
      this.execQuery(query, data, success, failAfterRepair, callback, false);
    });
  }

  /**
   * Replays every MySQL migration file and resolves true when all of them
   * applied. Queries that fail at the same moment share one replay, so two
   * repairs never race to add the same column.
   */
  private replayMysqlMigrationsSilently(): Promise<boolean> {
    if (this.mysqlReplay !== null) {
      return this.mysqlReplay;
    }
    if (this.migrationAutoRetryCount >= 2) {
      return Promise.resolve(false);
    }
    this.migrationAutoRetryCount++;
    this.hasRunMigrations = false;
    this.mysqlReplay = this.checkAndRunMigrations(null, true)
      .then(() => this.hasRunMigrations)
      .catch((err: any) => {
        console.error('Silent MySQL repair failed:', err);
        return false;
      })
      .finally(() => {
        this.mysqlReplay = null;
      });
    return this.mysqlReplay;
  }


  recordTestResults(data: any, success: any, errorf: any) {
    const orderData = { ...data };
    // Ensure instrument_id is set if not already present
    if (!orderData.instrument_id && orderData.machine_used) {
      orderData.instrument_id = orderData.machine_used;
    }

    const sqliteRecord = this.filterRecordColumns({
      ...orderData,
      added_on: orderData.added_on || this.receivedNow(),
      ingestion_id: orderData.ingestion_id || uuidv4(),
      lims_sync_status: orderData.lims_sync_status ?? 0,
      lims_sync_date_time: orderData.lims_sync_date_time ?? null,
      mysql_inserted: 0,
    }, DatabaseService.SQLITE_ORDER_COLUMNS);
    const sqliteInsert = this.buildInsertQuery('orders', sqliteRecord);

    // SQLite is the durability boundary. Remote availability must never decide
    // whether an instrument result is safely accepted by this application.
    this.execSqlite(sqliteInsert.query, sqliteInsert.values)
      .then((sqliteResult) => {
        this.replicateOrderToMySQL({ ...sqliteRecord, id: sqliteResult.lastID });
        this.resultRecordedSubject.next();
        const testOccurredAt = orderData.analysed_date_time
          || orderData.authorised_date_time
          || orderData.result_accepted_date_time;
        void this.recordTelemetryEvent({
          eventType: 'test.processed',
          category: 'test',
          instrumentId: orderData.instrument_id,
          machineType: orderData.telemetry_machine_type,
          protocol: orderData.telemetry_protocol,
          connectionMode: orderData.telemetry_connection_mode,
          testType: orderData.test_type,
          outcome: this.isFailedTestResult(orderData.results) ? 'failed' : 'success',
          ...(testOccurredAt ? { occurredAt: testOccurredAt } : {})
        });
        success(sqliteResult);
      })
      .catch(errorf);
  }

  public async recordTelemetryEvent(input: TelemetryEventInput): Promise<boolean> {
    const eventType = this.sanitizeTelemetryValue(input?.eventType, 64);
    if (!eventType) {
      console.warn('Skipped usage statistics event without a valid event type');
      return false;
    }

    const now = this.toDatabaseDateTime(input.occurredAt);
    const record = this.filterRecordColumns({
      event_id: uuidv4(),
      event_type: eventType,
      event_category: this.sanitizeTelemetryValue(input.category, 32) || 'usage',
      occurred_at: now,
      lab_id: this.sanitizeTelemetryValue(this.commonSettings?.labID, 128),
      source_installation_id: this.getOrCreateSourceInstallationId(),
      instrument_id: this.sanitizeTelemetryValue(input.instrumentId, 128),
      machine_type: this.sanitizeTelemetryValue(input.machineType, 128),
      protocol: this.sanitizeTelemetryValue(input.protocol, 32),
      connection_mode: this.sanitizeTelemetryValue(input.connectionMode, 32),
      test_type: this.sanitizeTelemetryValue(input.testType, 128),
      outcome: this.sanitizeTelemetryValue(input.outcome, 32) || 'success',
      failure_code: this.sanitizeTelemetryValue(input.failureCode, 64),
      event_count: Math.max(1, Math.min(Math.trunc(input.count || 1), 1_000_000)),
      app_version: this.sanitizeTelemetryValue(this.store?.get('appVersion'), 32),
      remote_uploaded_at: null,
      remote_batch_id: null,
      added_on: now,
      mysql_inserted: 0,
    }, DatabaseService.SQLITE_TELEMETRY_COLUMNS);
    const insert = this.buildInsertQuery('telemetry_events', record);

    try {
      const sqliteResult = await this.execSqlite(insert.query, insert.values);
      this.replicateTelemetryToMySQL({ ...record, id: sqliteResult.lastID });
      this.usageRecordedSubject?.next();
      return true;
    } catch (error) {
      // Usage reporting is observational. It must never interrupt instrument data.
      console.warn('Unable to save usage statistics:', error);
      return false;
    }
  }

  public resyncTelemetryToMySQL(success: any, errorf: any): void {
    if (!this.mysqlPool) {
      errorf('MySQL not available');
      return;
    }

    const selectSql = 'SELECT * FROM telemetry_events WHERE mysql_inserted = 0 ORDER BY id LIMIT ?';
    this.execSqlite(selectSql, [DatabaseService.MYSQL_TELEMETRY_RESYNC_LIMIT])
      .then((records: any[]) => {
        if (records.length === 0) {
          this.resyncUsageStatisticsDailyToMySQL(success, errorf);
          return;
        }

        const columns = DatabaseService.MYSQL_TELEMETRY_COLUMNS;
        const escapedColumns = columns.map(column => `\`${column}\``).join(',');
        const mysqlSql = `INSERT INTO \`telemetry_events\` (${escapedColumns}) VALUES ? ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)`;
        const values = records.map(record => columns.map(column => record[column] ?? null));

        this.execQuery(mysqlSql, [values],
          () => {
            this.markTelemetryAsResynced(records.map(record => record.id))
              .then(() => this.resyncUsageStatisticsDailyToMySQL(success, errorf))
              .catch(errorf);
          },
          errorf
        );
      })
      .catch(errorf);
  }

  private replicateTelemetryToMySQL(record: any): void {
    if (!this.mysqlPool) return;

    const mysqlRecord = this.filterRecordColumns(record, DatabaseService.MYSQL_TELEMETRY_COLUMNS);
    const insert = this.buildInsertQuery('telemetry_events', mysqlRecord);
    const idempotentInsert = `${insert.query} ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)`;
    this.execQuery(idempotentInsert, insert.values,
      () => {
        this.markTelemetryAsResynced([record.id]).catch(error => {
          console.warn('Usage statistics synchronized but the local status update failed:', error);
        });
        this.resyncUsageStatisticsDailyToMySQL(() => {}, () => {});
      },
      error => {
        console.warn('Usage statistics remain queued for MySQL synchronization:', error?.message ?? error);
      }
    );
  }

  private markTelemetryAsResynced(recordIds: number[]): Promise<void> {
    if (!recordIds.length) return Promise.resolve();
    const placeholders = recordIds.map(() => '?').join(',');
    return this.execSqlite(
      `UPDATE telemetry_events SET mysql_inserted = 1 WHERE id IN (${placeholders})`,
      recordIds
    ).then(() => undefined);
  }

  public resyncUsageStatisticsDailyToMySQL(success: any, errorf: any): void {
    if (!this.mysqlPool) {
      errorf('MySQL not available');
      return;
    }

    const selectSql = `
      SELECT * FROM usage_statistics_daily
      WHERE revision > mysql_synced_revision
      ORDER BY activity_date, id
      LIMIT ?`;
    this.execSqlite(selectSql, [DatabaseService.MYSQL_USAGE_STATISTICS_RESYNC_LIMIT])
      .then((records: any[]) => {
        if (records.length === 0) {
          success('Usage statistics are up to date.');
          return;
        }

        const columns = DatabaseService.MYSQL_USAGE_STATISTICS_COLUMNS;
        const escapedColumns = columns.map(column => `\`${column}\``).join(',');
        const assignments = columns
          .filter(column => column !== 'aggregate_id')
          .map(column => `\`${column}\` = IF(VALUES(\`revision\`) >= \`revision\`, VALUES(\`${column}\`), \`${column}\`)`)
          .join(',');
        const mysqlSql = `INSERT INTO \`usage_statistics_daily\` (${escapedColumns}) VALUES ? ON DUPLICATE KEY UPDATE ${assignments}`;
        const values = records.map(record => columns.map(column => record[column] ?? null));

        this.execQuery(mysqlSql, [values],
          () => {
            Promise.all(records.map(record => this.execSqlite(
              'UPDATE usage_statistics_daily SET mysql_synced_revision = ? WHERE id = ? AND revision = ?',
              [record.revision, record.id, record.revision]
            )))
              .then(() => success(`Synchronized ${records.length} daily usage summary row(s).`))
              .catch(errorf);
          },
          errorf
        );
      })
      .catch(errorf);
  }

  private sanitizeTelemetryValue(value: unknown, maxLength: number): string | null {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized ? normalized.slice(0, maxLength) : null;
  }

  private getOrCreateSourceInstallationId(): string {
    const stored = this.store?.get('sourceInstallationId');
    if (typeof stored === 'string' && stored.length >= 8) return stored.slice(0, 128);

    // WHY: the identity belongs to this installation, not its current LIS
    // connection, so reconnecting or using two installations cannot merge totals.
    const sourceInstallationId = `interface-${uuidv4()}`;
    this.store?.set?.('sourceInstallationId', sourceInstallationId);
    return sourceInstallationId;
  }

  /**
   * When a result or transmission is received, in the Settings time zone.
   * Both databases get the same value, rather than each its own default.
   */
  private receivedNow(): string {
    return formatInTimeZone(new Date(), this.commonSettings?.timeZone);
  }

  private toDatabaseDateTime(value?: Date | string): string {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.trim())) {
      return value.trim();
    }
    let date = new Date();
    if (value instanceof Date) {
      date = value;
    } else if (value) {
      date = new Date(value);
    }
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    return safeDate.toISOString().slice(0, 19).replace('T', ' ');
  }

  private isFailedTestResult(value: unknown): boolean {
    return ['failed', 'error', 'invalid', 'incomplete'].includes(String(value ?? '').trim().toLowerCase());
  }

  private replicateOrderToMySQL(record: any): void {
    this.checkMysqlConnection(null, () => {
      const mysqlRecord = this.filterRecordColumns(record, DatabaseService.MYSQL_ORDER_COLUMNS);
      const mysqlInsert = this.buildInsertQuery('orders', mysqlRecord);
      const idempotentInsert = `${mysqlInsert.query} ON DUPLICATE KEY UPDATE ingestion_id = VALUES(ingestion_id)`;

      this.execQuery(idempotentInsert, mysqlInsert.values,
        () => {
          this.markOrdersAsResynced([record])
            .catch((error: any) => {
              // A retry is safe because ingestion_id is stable and unique remotely.
              this.logCriticalDatabaseIssue(
                `Result replicated but local status update failed: ${error?.message ?? error}`,
                'database',
                record.instrument_id
              );
            })
            .finally(() => this.resyncIntelisStatusesInBackground());
        },
        (mysqlError) => {
          this.logCriticalDatabaseIssue(
            `Error inserting into MySQL orders: ${mysqlError?.message ?? mysqlError}`,
            'database',
            record.instrument_id
          );
        }
      );
    }, (error) => {
      console.error('MySQL connection failed; result remains queued in SQLite:', error?.message ?? error);
    });
  }


  resyncTestResultsToMySQL(success: any, errorf: any) {
    const sqliteQuery = 'SELECT * FROM orders WHERE mysql_inserted = 0';

    this.execSqlite(sqliteQuery, [])
      .catch((err: any) => {
        errorf('Error fetching records from SQLite:', err);
        return null;
      })
      .then((records) => {
        if (records === null) {
          return null;
        }
        if (records.length === 0) {
          success('No records to resync.');
          return null;
        }
        return this.ensureOrderIngestionIds(records);
      })
      .then((preparedRecords) => {
        if (preparedRecords !== null) {
          this.processResyncRecords(preparedRecords, success, errorf);
        }
      })
      .catch(errorf);
  }

  private async ensureOrderIngestionIds(records: any[]): Promise<any[]> {
    for (const record of records) {
      if (record.ingestion_id) {
        continue;
      }

      const generatedId = uuidv4();
      await this.execSqlite(
        'UPDATE orders SET ingestion_id = ? WHERE id = ? AND ingestion_id IS NULL',
        [generatedId, record.id]
      );
      const [persistedRecord] = await this.execSqlite(
        'SELECT ingestion_id FROM orders WHERE id = ?',
        [record.id]
      );
      record.ingestion_id = persistedRecord?.ingestion_id;
      if (!record.ingestion_id) {
        throw new Error(`Could not assign ingestion identity to local order ${record.id}`);
      }
    }

    return records;
  }

  /** Copies InteLIS statuses to MySQL without waiting for or reporting the outcome. */
  private resyncIntelisStatusesInBackground(): void {
    this.resyncIntelisStatusesToMySQL(() => {}, () => {});
  }

  private processResyncRecords(records: any[], success: any, errorf: any) {
    // WHY: previous version did `records.forEach(execQuery)` which fired N
    // parallel inserts via IPC on each tick. With a backlog this saturated
    // the IPC channel and the MySQL connection. Batched, sequential inserts
    // keep the renderer responsive while still draining the backlog quickly.
    const columns = DatabaseService.MYSQL_ORDER_COLUMNS;
    const escapedColumns = columns.map(c => `\`${c}\``).join(',');
    const mysqlQuery = `INSERT INTO \`orders\` (${escapedColumns}) VALUES ? ON DUPLICATE KEY UPDATE ingestion_id = VALUES(ingestion_id)`;
    const batches = this.chunkArray(records, DatabaseService.MYSQL_ORDER_RESYNC_BATCH_SIZE);
    let batchIndex = 0;

    this.checkMysqlConnection(null, () => {
      const processNextBatch = () => {
        const batch = batches[batchIndex];
        if (!batch) {
          success('Resync process completed.');
          return;
        }

        batchIndex++;
        const firstInstrumentId = batch.find(r => !!r.instrument_id)?.instrument_id ?? null;
        // Normalize each record to the full column set, nulls for missing
        // fields. Required for the bulk-insert `VALUES ?` shape.
        const mysqlValues = batch.map(record =>
          columns.map(col => record[col] ?? null)
        );

        this.execQuery(mysqlQuery, [mysqlValues],
          () => {
            this.markOrdersAsResynced(batch)
              .catch((error: any) => {
                this.logCriticalDatabaseIssue(
                  `Results replicated but local status update failed: ${error?.message ?? error}`,
                  'database',
                  firstInstrumentId
                );
              })
              .finally(() => {
                this.resyncIntelisStatusesInBackground();
                processNextBatch();
              });
          },
          (batchError) => {
            // Whole batch failed (one bad row poisons the bulk INSERT). Log
            // and move on so we don't get stuck retrying the same batch
            // forever — those records stay mysql_inserted=0 and will be
            // retried next tick.
            this.logCriticalDatabaseIssue(
              `Error resyncing orders batch (${batch.length} records) to MySQL: ${batchError?.message ?? batchError}`,
              'database',
              firstInstrumentId
            );
            processNextBatch();
          }
        );
      };

      processNextBatch();
    }, () => {
      errorf('MySQL not available');
    });
  }

  private markOrdersAsResynced(records: any[]): Promise<void> {
    if (!records || records.length === 0) {
      return Promise.resolve();
    }

    // Only acknowledge the exact status snapshot that was sent. A cloud API
    // acknowledgement may change the row while MySQL is still writing; marking
    // that newer state as replicated would otherwise lose the status update.
    return Promise.all(records.map(record => this.execSqlite(
      `UPDATE orders
       SET mysql_inserted = 1
       WHERE id = ?
         AND lims_sync_status IS ?
         AND lims_sync_date_time IS ?`,
      [record.id, record.lims_sync_status ?? null, record.lims_sync_date_time ?? null]
    ))).then(() => {
      console.log('Order records successfully resynced and updated in SQLite:', records.length);
    });
  }

  public async fetchPendingIntelisResults(maxItems: number): Promise<{
    rows: IntelisResultRow[];
    hasMore: boolean;
    oversizedResultCount: number;
  }> {
    const records = await this.execSqlite(
      `SELECT id, order_id, test_id, results, test_unit, machine_used,
              instrument_id, tested_by, authorised_date_time,
              result_accepted_date_time, raw_text
       FROM orders
       WHERE lims_sync_status = 0
       ORDER BY id
       LIMIT ?`,
      [maxItems + 1]
    );

    const hasMore = records.length > maxItems;
    let selectedRecords = records;
    let oversizedResultCount = 0;
    if (hasMore) {
      const boundary = records[maxItems];
      const boundaryKey = JSON.stringify([boundary.order_id ?? '', boundary.test_id ?? '']);
      const firstPage = records.slice(0, maxItems);

      // The extra row tells us whether the item boundary cuts through the
      // server's duplicate-unit comparison group. Defer that whole group so
      // copies and log values can never be separated across requests.
      selectedRecords = firstPage.filter(record =>
        JSON.stringify([record.order_id ?? '', record.test_id ?? '']) !== boundaryKey
      );
      if (selectedRecords.length === 0) {
        oversizedResultCount = records.filter(record =>
          JSON.stringify([record.order_id ?? '', record.test_id ?? '']) === boundaryKey
        ).length;
      }
    }

    const rows = selectedRecords.map((record: any) => ({
      id: Number(record.id),
      order_id: String(record.order_id ?? ''),
      test_id: String(record.test_id ?? ''),
      results: record.results === null || record.results === undefined ? null : String(record.results),
      test_unit: record.test_unit === null || record.test_unit === undefined ? null : String(record.test_unit),
      machine_used: String(record.machine_used ?? record.instrument_id ?? ''),
      instrument_id: record.instrument_id === null || record.instrument_id === undefined
        ? null
        : String(record.instrument_id),
      tested_by: record.tested_by === null || record.tested_by === undefined ? null : String(record.tested_by),
      authorised_date_time: record.authorised_date_time ?? null,
      result_accepted_date_time: record.result_accepted_date_time ?? null,
      raw_text: record.raw_text ?? null
    }));
    return { rows, hasMore, oversizedResultCount };
  }

  public async applyIntelisResultAcknowledgements(
    acknowledgements: IntelisResultAcknowledgement[]
  ): Promise<void> {
    for (const batch of this.chunkArray(acknowledgements, 200)) {
      const statusCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
      const ids = batch.map(item => item.id);
      const statusValues = batch.flatMap(item => [item.id, item.limsSyncStatus]);
      const placeholders = ids.map(() => '?').join(',');

      // The status comes directly from the server. Mark the MySQL projection
      // pending so legacy readers see the same final state after the next sync.
      await this.execSqlite(
        `UPDATE orders
         SET lims_sync_status = CASE id ${statusCases} ELSE lims_sync_status END,
             lims_sync_date_time = CURRENT_TIMESTAMP,
             mysql_status_synced = 0
         WHERE lims_sync_status = 0 AND id IN (${placeholders})`,
        [...statusValues, ...ids]
      );
    }
  }

  public async fetchPendingResultWebhookResults(maxItems: number): Promise<{
    results: ResultWebhookResult[];
    hasMore: boolean;
  }> {
    const columns = RESULT_WEBHOOK_RESULT_FIELDS.map(field => `\`${field}\``).join(', ');
    const records = await this.execSqlite(
      `SELECT ${columns}
       FROM orders
       WHERE result_webhook_status = ?
       ORDER BY id
       LIMIT ?`,
      [RESULT_WEBHOOK_STATUS.PENDING, maxItems + 1]
    );
    const hasMore = records.length > maxItems;
    // The ingestion ID is the receiver's duplicate key, so a row never leaves
    // without one.
    const selected = await this.ensureOrderIngestionIds(records.slice(0, maxItems));
    return { results: selected.map(record => toResultWebhookResult(record)), hasMore };
  }

  /** Only rows still pending move: a delivery never overwrites another state. */
  public async markResultWebhookDelivered(ids: number[]): Promise<void> {
    for (const batch of this.chunkArray(ids, 200)) {
      const placeholders = batch.map(() => '?').join(',');
      await this.execSqlite(
        `UPDATE orders
         SET result_webhook_status = ?
         WHERE result_webhook_status = ? AND id IN (${placeholders})`,
        [RESULT_WEBHOOK_STATUS.DELIVERED, RESULT_WEBHOOK_STATUS.PENDING, ...batch]
      );
    }
  }

  public async countPendingResultWebhookResults(): Promise<number> {
    const [row] = await this.execSqlite(
      'SELECT COUNT(*) AS pending FROM orders WHERE result_webhook_status = ?',
      [RESULT_WEBHOOK_STATUS.PENDING]
    );
    return Number(row?.pending ?? 0);
  }

  public async fetchPendingIntelisActivity(maxItems: number): Promise<IntelisActivityEvent[]> {
    const records = await this.execSqlite(
      `SELECT event_id, event_type, event_category, occurred_at, instrument_id,
              machine_type, protocol, connection_mode, test_type, outcome,
              failure_code, event_count, app_version
       FROM telemetry_events
       WHERE remote_uploaded_at IS NULL
       ORDER BY id
       LIMIT ?`,
      [maxItems]
    );
    return records.map((record: any) => ({
      event_id: String(record.event_id),
      event_type: String(record.event_type),
      event_category: String(record.event_category),
      occurred_at: String(record.occurred_at),
      instrument_id: record.instrument_id ?? null,
      machine_type: record.machine_type ?? null,
      protocol: record.protocol ?? null,
      connection_mode: record.connection_mode ?? null,
      test_type: record.test_type ?? null,
      outcome: record.outcome ?? null,
      failure_code: record.failure_code ?? null,
      event_count: Number(record.event_count),
      app_version: record.app_version ?? null,
    }));
  }

  public async acknowledgeIntelisActivity(events: IntelisActivityEvent[]): Promise<void> {
    if (events.length === 0) return;
    for (const batch of this.chunkArray(events, 200)) {
      const placeholders = batch.map(() => '?').join(',');
      await this.execSqlite(
        `UPDATE telemetry_events
         SET remote_uploaded_at = CURRENT_TIMESTAMP
         WHERE remote_uploaded_at IS NULL AND event_id IN (${placeholders})`,
        batch.map(event => event.event_id)
      );
    }
  }

  public async fetchPendingIntelisUsageStatistics(maxItems: number): Promise<IntelisUsageSummary[]> {
    const records = await this.execSqlite(
      `SELECT aggregate_id, activity_date, instrument_id, machine_type, test_type,
              total_tests, successful_tests, failed_tests, first_test_at,
              last_test_at, revision
       FROM usage_statistics_daily
       WHERE revision > remote_uploaded_revision
       ORDER BY activity_date, id
       LIMIT ?`,
      [maxItems]
    );
    return records.map((record: any) => ({
      aggregate_id: String(record.aggregate_id),
      activity_date: String(record.activity_date),
      instrument_id: record.instrument_id || null,
      machine_type: record.machine_type || null,
      test_type: record.test_type || null,
      total_tests: Number(record.total_tests),
      successful_tests: Number(record.successful_tests),
      failed_tests: Number(record.failed_tests),
      first_test_at: record.first_test_at ?? null,
      last_test_at: record.last_test_at ?? null,
      revision: Number(record.revision),
    }));
  }

  public async acknowledgeIntelisUsageStatistics(
    acknowledgements: IntelisUsageSummaryAcknowledgement[]
  ): Promise<void> {
    for (const acknowledgement of acknowledgements) {
      // WHY: a test may finish while the request is in flight. Only acknowledge
      // the exact revision sent so the newer absolute total remains pending.
      await this.execSqlite(
        `UPDATE usage_statistics_daily
         SET remote_uploaded_revision = ?
         WHERE aggregate_id = ? AND revision = ?`,
        [acknowledgement.revision, acknowledgement.aggregate_id, acknowledgement.revision]
      );
    }
  }

  public resyncIntelisStatusesToMySQL(success: any, errorf: any): void {
    if (!this.mysqlPool) {
      errorf('MySQL not available');
      return;
    }

    this.execSqlite(
      `SELECT id, ingestion_id, lims_sync_status, lims_sync_date_time
       FROM orders
       WHERE mysql_status_synced = 0 AND mysql_inserted = 1
       ORDER BY id
       LIMIT 500`,
      []
    ).then((records: any[]) => {
      const identifiedRecords = records.filter(record => !!record.ingestion_id);
      if (identifiedRecords.length === 0) {
        success('No result statuses to project.');
        return;
      }

      const batches = this.chunkArray(identifiedRecords, 100);
      let batchIndex = 0;
      const processNext = () => {
        const batch = batches[batchIndex++];
        if (!batch) {
          success(`Projected ${identifiedRecords.length} result status update(s).`);
          return;
        }

        const statusCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
        const dateCases = batch.map(() => 'WHEN ? THEN ?').join(' ');
        const ingestionIds = batch.map(record => record.ingestion_id);
        const placeholders = ingestionIds.map(() => '?').join(',');
        const values = [
          ...batch.flatMap(record => [record.ingestion_id, record.lims_sync_status]),
          ...batch.flatMap(record => [record.ingestion_id, record.lims_sync_date_time]),
          ...ingestionIds
        ];
        const query = `UPDATE orders
          SET lims_sync_status = CASE ingestion_id ${statusCases} ELSE lims_sync_status END,
              lims_sync_date_time = CASE ingestion_id ${dateCases} ELSE lims_sync_date_time END
          WHERE ingestion_id IN (${placeholders})`;

        this.execQuery(query, values, () => {
          Promise.all(batch.map(record => this.execSqlite(
            `UPDATE orders
             SET mysql_status_synced = 1
             WHERE id = ?
               AND lims_sync_status IS ?
               AND lims_sync_date_time IS ?`,
            [record.id, record.lims_sync_status, record.lims_sync_date_time]
          ))).then(processNext).catch(errorf);
        }, errorf);
      };

      processNext();
    }).catch(errorf);
  }

  /**
   * Where raw data is read from: MySQL when it is configured and answers,
   * since it can hold history from before this installation, else SQLite.
   */
  public async rawDataStore(): Promise<RawDataStore> {
    if (!this.mysqlPool) {
      return 'sqlite';
    }
    return new Promise(resolve => this.checkMysqlConnection(null, () => resolve('mysql'), () => resolve('sqlite')));
  }

  private runOn(store: RawDataStore, sql: string, params: any[] = []): Promise<any> {
    return store === 'mysql' ? this.execQueryPromise(sql, params) : this.execSqlite(sql, params);
  }

  /** The WHERE clause for a raw data filter, every value a parameter. */
  private rawDataWhere(filter: RawDataFilter = {}): { sql: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    if (filter.instrumentId) {
      clauses.push('instrument_id = ?');
      params.push(filter.instrumentId);
    }
    if (filter.from) {
      clauses.push('added_on >= ?');
      params.push(`${filter.from} 00:00:00`);
    }
    if (filter.to) {
      clauses.push('added_on < ?');
      params.push(`${DatabaseService.dayAfter(filter.to)} 00:00:00`);
    }
    const search = (filter.search ?? '').trim();
    if (search) {
      const escaped = search.replaceAll(/[!%_]/g, '!$&');
      const pattern = `%${escaped}%`;
      clauses.push("(instrument_id LIKE ? ESCAPE '!' OR machine LIKE ? ESCAPE '!' OR added_on LIKE ? ESCAPE '!' OR data LIKE ? ESCAPE '!')");
      params.push(pattern, pattern, pattern, pattern);
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /** The day after a YYYY-MM-DD day, in the same form. */
  static dayAfter(day: string): string {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  }

  /** One page of stored transmissions matching the filter, newest first. */
  public async listRawData(filter: RawDataFilter, limit: number, offset: number): Promise<{ store: RawDataStore; rows: StoredTransmission[]; total: number }> {
    const store = await this.rawDataStore();
    const where = this.rawDataWhere(filter);
    const [count] = await this.runOn(store, `SELECT COUNT(*) AS total FROM raw_data${where.sql}`, where.params);
    const rows = await this.runOn(
      store,
      `SELECT id, data, machine, instrument_id, added_on, transmission_id, sha256
       FROM raw_data${where.sql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...where.params, Math.trunc(limit), Math.trunc(offset)]
    );
    return { store, rows: rows.map((row: any) => ({ ...row, store })), total: Number(count?.total ?? 0) };
  }

  /** Every instrument that has stored raw data. */
  public async listRawDataInstruments(store: RawDataStore): Promise<string[]> {
    const rows = await this.runOn(
      store,
      'SELECT DISTINCT instrument_id FROM raw_data WHERE instrument_id IS NOT NULL ORDER BY instrument_id'
    );
    return rows.map((row: any) => String(row.instrument_id));
  }

  public async countRawData(store: RawDataStore, filter: RawDataFilter): Promise<number> {
    const where = this.rawDataWhere(filter);
    const [count] = await this.runOn(store, `SELECT COUNT(*) AS total FROM raw_data${where.sql}`, where.params);
    return Number(count?.total ?? 0);
  }

  /**
   * The next stored transmissions matching the filter after the given row,
   * oldest first. Walking by id keeps a long run stable while new
   * transmissions arrive.
   */
  public async nextRawDataBatch(
    store: RawDataStore,
    filter: RawDataFilter,
    afterId: number,
    limit: number,
    order: 'asc' | 'desc' = 'asc'
  ): Promise<StoredTransmission[]> {
    const where = this.rawDataWhere(filter);
    const idClause = order === 'asc' ? 'id > ?' : 'id < ?';
    const sql = `SELECT id, data, machine, instrument_id, added_on, transmission_id, sha256
       FROM raw_data${where.sql ? `${where.sql} AND ${idClause}` : ` WHERE ${idClause}`}
       ORDER BY id ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT ?`;
    const rows = await this.runOn(store, sql, [...where.params, afterId, Math.trunc(limit)]);
    return rows.map((row: any) => ({ ...row, store }));
  }

  /**
   * The identifier and fingerprint of a stored transmission, given to it
   * now if it was stored before either existed. Returns the identifier.
   */
  public async ensureTransmissionIdentity(entry: StoredTransmission): Promise<string> {
    if (entry.transmission_id) {
      return entry.transmission_id;
    }
    await this.runOn(
      entry.store,
      'UPDATE raw_data SET transmission_id = ?, sha256 = COALESCE(sha256, ?) WHERE id = ? AND transmission_id IS NULL',
      [uuidv4(), transmissionSha256(entry.data), entry.id]
    );
    // Read back: another run may have given it one first.
    const [row] = await this.runOn(entry.store, 'SELECT transmission_id, sha256 FROM raw_data WHERE id = ?', [entry.id]);
    if (!row?.transmission_id) {
      throw new Error(`Could not identify stored transmission ${entry.id}`);
    }
    entry.transmission_id = row.transmission_id;
    entry.sha256 = row.sha256;
    return entry.transmission_id;
  }

  /** The stored transmission a result came from, looked for locally first. */
  public async findTransmission(transmissionId: string): Promise<StoredTransmission | null> {
    const sql = `SELECT id, data, machine, instrument_id, added_on, transmission_id, sha256
       FROM raw_data WHERE transmission_id = ? LIMIT 1`;
    const [local] = await this.execSqlite(sql, [transmissionId]);
    if (local) {
      return { ...local, store: 'sqlite' };
    }
    if (this.mysqlPool) {
      try {
        const [remote] = await this.execQueryPromise(sql, [transmissionId]);
        if (remote) {
          return { ...remote, store: 'mysql' };
        }
      } catch {
        // An unreachable MySQL copy means the transmission is not found here.
      }
    }
    return null;
  }

  /**
   * The condition that a stored result is the one in `record`: same sample,
   * test, value, unit, notes, status, operator and times, from the same
   * instrument or from a row that never recorded its instrument. A value
   * stored before results_as_sent existed is compared as stored. The sample
   * ID is compared again exactly once read, since MySQL's usual collations
   * ignore case and trailing spaces.
   */
  private static readonly IDENTICAL_RESULT_SQL = `SELECT order_id FROM orders
    WHERE order_id = ?
      AND (COALESCE(instrument_id, machine_used) = ? OR COALESCE(instrument_id, machine_used) IS NULL)
      AND COALESCE(test_id, '') = COALESCE(?, '')
      AND COALESCE(test_type, '') = COALESCE(?, '')
      AND COALESCE(results, '') = COALESCE(?, '')
      AND (COALESCE(results_as_sent, '') = COALESCE(?, '') OR results_as_sent IS NULL)
      AND COALESCE(test_unit, '') = COALESCE(?, '')
      AND COALESCE(notes, '') = COALESCE(?, '')
      AND COALESCE(tested_by, '') = COALESCE(?, '')
      AND COALESCE(analysed_date_time, '') = COALESCE(?, '')
      AND COALESCE(specimen_date_time, '') = COALESCE(?, '')
      AND COALESCE(authorised_date_time, '') = COALESCE(?, '')
      AND COALESCE(result_accepted_date_time, '') = COALESCE(?, '')
      AND result_status = ?
      AND (COALESCE(result_status_as_sent, '') = COALESCE(?, '') OR result_status_as_sent IS NULL)`;

  /** True when a result exactly like this one is already stored. */
  public async findIdenticalResult(record: any): Promise<boolean> {
    const params = [
      record.order_id, record.instrument_id ?? record.machine_used ?? null, record.test_id ?? null, record.test_type ?? null,
      record.results ?? null, record.results_as_sent ?? null, record.test_unit ?? null, record.notes ?? null,
      record.tested_by ?? null, record.analysed_date_time ?? null, record.specimen_date_time ?? null,
      record.authorised_date_time ?? null, record.result_accepted_date_time ?? null, Number(record.result_status ?? 0),
      record.result_status_as_sent ?? null
    ];
    return this.foundInEitherStore(DatabaseService.IDENTICAL_RESULT_SQL, params, record.order_id);
  }

  /** True when any result is already stored for this sample and test. */
  public async hasEarlierResult(record: any): Promise<boolean> {
    const sql = `SELECT order_id FROM orders
      WHERE order_id = ?
        AND (COALESCE(instrument_id, machine_used) = ? OR COALESCE(instrument_id, machine_used) IS NULL)
        AND COALESCE(test_type, '') = COALESCE(?, '')`;
    return this.foundInEitherStore(sql, [record.order_id, record.instrument_id ?? record.machine_used ?? null, record.test_type ?? null], record.order_id);
  }

  private async foundInEitherStore(sql: string, params: any[], orderId: string): Promise<boolean> {
    const sameSample = (rows: any[]) => rows.some(row => String(row.order_id) === String(orderId));
    if (sameSample(await this.execSqlite(sql, params))) {
      return true;
    }
    // MySQL can hold results from before this installation's SQLite.
    if (this.mysqlPool) {
      try {
        return sameSample(await this.execQueryPromise(sql, params));
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Results with the given sample ID that do not yet carry a transmission
   * identifier, stored no earlier than `notBefore`: the rows compacting
   * storage may link to a transmission received at that time.
   */
  /** Compared again exactly once read: MySQL's usual collations ignore case. */
  public async unlinkedResultsFor(store: RawDataStore, orderId: string, notBefore: string | null, settled: SettledResults | null = null): Promise<any[]> {
    let clauses = '';
    const params: any[] = [orderId];
    if (notBefore) {
      clauses += ' AND (added_on IS NULL OR added_on >= ?)';
      params.push(notBefore);
    }
    if (settled) {
      // Only results already sent, and stored before the cut-off.
      clauses += ' AND lims_sync_status <> 0 AND added_on < ?';
      params.push(settled.storedBefore);
      if (settled.webhookDelivered) {
        clauses += ' AND result_webhook_status <> 0';
      }
    }
    return this.runOn(
      store,
      `SELECT id, order_id, test_id, test_type, results, results_as_sent, analysed_date_time, raw_text,
              LENGTH(raw_text) AS raw_text_length
       FROM orders
       WHERE order_id = ? AND transmission_id IS NULL AND raw_text IS NOT NULL${clauses}`,
      params
    ).then((rows: any[]) => rows.filter(row => String(row.order_id) === orderId));
  }

  /**
   * Links a result to the transmission it came from and keeps only the
   * records it was read from. Changes nothing if the row was linked or its
   * raw text changed since it was read.
   * @param previousLength LENGTH(raw_text) as this database reported it
   * when the row was read (characters in SQLite, bytes in MySQL)
   * @param settled when given, the row must still be settled as it was when
   * read: a result requeued for sending meanwhile is left alone
   */
  public async linkResultToTransmission(
    store: RawDataStore,
    id: number,
    transmissionId: string,
    rawText: string,
    previousLength: number,
    settled: SettledResults | null = null
  ): Promise<boolean> {
    let settledClause = '';
    if (settled) {
      settledClause = settled.webhookDelivered
        ? ' AND lims_sync_status <> 0 AND result_webhook_status <> 0'
        : ' AND lims_sync_status <> 0';
    }
    const result = await this.runOn(
      store,
      `UPDATE orders SET transmission_id = ?, raw_text = ?
       WHERE id = ? AND transmission_id IS NULL AND LENGTH(raw_text) = ?${settledClause}`,
      [transmissionId, rawText, id, previousLength]
    );
    return Number(result?.changes ?? result?.affectedRows ?? 0) > 0;
  }

  public async storageUsage(): Promise<{ sqlite: StoreUsage; mysql: StoreUsage }> {
    const sqlite = await this.storeUsage('sqlite');
    try {
      const appPath = this.store?.get('appPath');
      sqlite.fileBytes = appPath ? Number(this.electronService.fs.statSync(appPath).size) : null;
    } catch {
      sqlite.fileBytes = null;
    }
    let mysql: StoreUsage = {
      available: false, results: 0, resultTextBytes: 0, linkedResults: 0, transmissions: 0, transmissionBytes: 0, fileBytes: null
    };
    if (this.mysqlPool) {
      try {
        mysql = await this.storeUsage('mysql');
      } catch {
        // Space in the optional MySQL copy is reported as unavailable.
      }
    }
    return { sqlite, mysql };
  }

  private async storeUsage(store: RawDataStore): Promise<StoreUsage> {
    const [orders] = await this.runOn(store, `SELECT COUNT(*) AS results,
        COALESCE(SUM(LENGTH(raw_text)), 0) AS text_bytes,
        COALESCE(SUM(CASE WHEN transmission_id IS NULL THEN 0 ELSE 1 END), 0) AS linked
      FROM orders`);
    const [raw] = await this.runOn(store, `SELECT COUNT(*) AS transmissions, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM raw_data`);
    return {
      available: true,
      results: Number(orders?.results ?? 0),
      resultTextBytes: Number(orders?.text_bytes ?? 0),
      linkedResults: Number(orders?.linked ?? 0),
      transmissions: Number(raw?.transmissions ?? 0),
      transmissionBytes: Number(raw?.bytes ?? 0),
      fileBytes: null
    };
  }

  /** Results in SQLite with no analyzer status, in id order after `afterId`. */
  public resultsWithoutStatus(afterId: number, limit: number): Promise<Array<{ id: number; order_id: string; raw_text: string }>> {
    return this.execSqlite(
      `SELECT id, order_id, raw_text FROM orders
       WHERE result_status_as_sent IS NULL AND raw_text IS NOT NULL AND id > ?
       ORDER BY id LIMIT ?`,
      [afterId, limit]
    );
  }

  /** Stores the analyzer status of a result in SQLite, unless it has one already. */
  public async setResultStatusAsSent(id: number, letter: string): Promise<void> {
    await this.execSqlite('UPDATE orders SET result_status_as_sent = ? WHERE id = ? AND result_status_as_sent IS NULL', [letter, id]);
  }

  /** Results that still carry a copy of their transmission and no link to it. */
  public async countUnlinkedResults(store: RawDataStore): Promise<number> {
    const [row] = await this.runOn(store, 'SELECT COUNT(*) AS unlinked FROM orders WHERE transmission_id IS NULL AND raw_text IS NOT NULL');
    return Number(row?.unlinked ?? 0);
  }

  /**
   * Gives back to the disk the space freed inside the MySQL database, which
   * keeps it in its tablespace until the table is rebuilt. SQLite is
   * rewritten at start instead (`ElectronService.rewriteSqliteAtStart`).
   */
  /** Space inside the SQLite file that a rewrite would give back to the disk. */
  public async sqliteFreeBytes(): Promise<number> {
    const [pages] = await this.execSqlite('PRAGMA freelist_count', []);
    const [size] = await this.execSqlite('PRAGMA page_size', []);
    return Number(pages?.freelist_count ?? 0) * Number(size?.page_size ?? 0);
  }

  public async reclaimMysqlSpace(): Promise<void> {
    await this.execQueryPromise('OPTIMIZE TABLE `orders`', []);
  }

  fetchRecentResults(searchParam: string = ''): Observable<any[]> {
    const subject = new Subject<any[]>();
    const trimmedSearchParam = (searchParam || '').trim();

    let recentResultsQuery = 'SELECT * FROM orders';
    let queryParams = [];

    if (trimmedSearchParam !== '') {
      const searchTerm = `%${trimmedSearchParam}%`;
      const columns = [
        'order_id', 'test_id', 'test_type', 'created_date', 'test_unit',
        'results', 'tested_by', 'analysed_date_time', 'specimen_date_time',
        'authorised_date_time', 'result_accepted_date_time', 'machine_used',
        'test_location', 'test_description', 'notes', 'raw_text', 'added_on',
        'lims_sync_status', 'lims_sync_date_time'
      ];
      const searchConditions = columns.map(col => `${col} LIKE ?`).join(' OR ');
      recentResultsQuery += ` WHERE ${searchConditions}`;
      queryParams = new Array(columns.length).fill(searchTerm);
    }

    // Newest first by row id, the order results arrived. added_on is a wall
    // time with no zone, so it can run backwards across a time zone change.
    recentResultsQuery += ' ORDER BY id DESC LIMIT 1000';

    this.execSqlite(recentResultsQuery, queryParams)
      .then(results => {
        subject.next(results);
        subject.complete();
      })
      .catch(error => {
        console.error('Database query error:', error);
        subject.error(error);
        subject.complete();
      });

    return subject.asObservable();
  }

  reSyncRecord(orderId: string): Observable<any> {
    const subject = new Subject<any>();
    const updateQuery = `UPDATE orders SET lims_sync_status = '0', lims_sync_date_time = CURRENT_TIMESTAMP WHERE order_id = ?`;
    this.execQuery(
      updateQuery,
      [orderId],
      (result) => {
        console.log('Record re-synced successfully:', result);
        subject.next(result);
        subject.complete();
      },
      (error) => {
        console.error('Error while re-syncing record:', error);
        subject.error(error);
        subject.complete();
      }
    );
    return subject.asObservable();
  }

  syncLimsStatusToSQLite(success: (result: { updatedCount: number; message: string }) => void, errorf: any) {

    // Step 1: Get the maximum `lims_sync_date_time` from SQLite
    const sqliteMaxQuery = 'SELECT MAX(lims_sync_date_time) as maxSyncDate FROM orders';

    this.execSqlite(sqliteMaxQuery, [])
      .then((sqliteResult: any) => {
        const maxSyncDate = sqliteResult[0]?.maxSyncDate || '0000-00-00 00:00:00';

        // Step 2: Query MySQL for records with `lims_sync_date_time` greater than `maxSyncDate`
        const mysqlQuery = `
          SELECT order_id, lims_sync_status, lims_sync_date_time
          FROM orders
          WHERE lims_sync_date_time > ?
          ORDER BY lims_sync_date_time ASC
        `;

        this.checkMysqlConnection(null, () => {
          this.execQuery(mysqlQuery, [maxSyncDate],
            async (mysqlResults: any[]) => {
              if (!mysqlResults || mysqlResults.length === 0) {
                success({ updatedCount: 0, message: 'No updates to sync.' });
                return;
              }

              // Step 3: Update SQLite sequentially. Previously this fanned out
              // N parallel UPDATEs through IPC; sequencing keeps the renderer
              // responsive when a large batch arrives at once.
              const sqliteUpdateQuery = `
                UPDATE orders
                SET lims_sync_status = ?, lims_sync_date_time = ?
                WHERE order_id = ?
              `;
              let updated = 0;
              for (const record of mysqlResults) {
                try {
                  await this.execSqlite(sqliteUpdateQuery, [
                    record.lims_sync_status,
                    record.lims_sync_date_time,
                    record.order_id
                  ]);
                  updated++;
                } catch (error) {
                  console.error('Error updating SQLite for order', record.order_id, error);
                }
              }
              success({ updatedCount: updated, message: 'Sync completed.' });
            },
            (mysqlError) => {
              console.error('Error querying MySQL for updates:', mysqlError);
              errorf(mysqlError);
            });
        }, (mysqlConnectionError) => {
          console.error('Error connecting to MySQL:', mysqlConnectionError);
          errorf(mysqlConnectionError);
        });

      })
      .catch((sqliteError: any) => {
        console.error('Error fetching max lims_sync_date_time from SQLite:', sqliteError);
        errorf(sqliteError);
      });
  }


  fetchLastSyncTimes(): Observable<any> {
    const subject = new Subject<any>();
    const syncQuery = 'SELECT MAX(lims_sync_date_time) as lastLimsSync FROM `orders`';
    // The last result received is the newest local row. Every result is stored
    // in SQLite first, so its ids follow arrival. MySQL ids follow copying,
    // which a queued result can reach late, and the largest added_on can be
    // an older row after a time zone change.
    const receivedQuery = 'SELECT added_on as lastResultReceived FROM `orders` ORDER BY id DESC LIMIT 1';

    const finish = (syncRow: any) => {
      this.execSqlite(receivedQuery, [])
        .then(rows => {
          subject.next({ ...syncRow, lastResultReceived: rows[0]?.lastResultReceived ?? null });
          subject.complete();
        })
        .catch(error => {
          subject.error(error);
          subject.complete();
        });
    };

    this.checkMysqlConnection(null, () => {
      this.execQuery(syncQuery, null, (res) => finish(res[0]), (err) => {
        subject.error(err);
        subject.complete();
      });
    }, () => {
      this.execSqlite(syncQuery, null)
        .then(res => finish(res[0]))
        .catch(error => {
          subject.error(error);
          subject.complete();
        });
    });

    return subject.asObservable();
  }


  // In database.service.ts, replace the recordRawData method with this version:

  // In database.service.ts, update the recordRawData method:

  recordRawData(data, success, errorf) {
    // Every transmission is stored with an identifier, the same in SQLite and
    // MySQL, and a fingerprint of its bytes.
    const rawData = {
      ...data,
      transmission_id: data.transmission_id || uuidv4(),
      sha256: data.sha256 || transmissionSha256(data.data),
      added_on: data.added_on || this.receivedNow(),
    };

    const handleSQLiteInsert = (mysqlInserted: boolean) => {
      const sqliteRecord = this.filterRecordColumns({
        ...rawData,
        mysql_inserted: mysqlInserted ? 1 : 0,
      }, DatabaseService.SQLITE_RAW_DATA_COLUMNS);
      const sqliteInsert = this.buildInsertQuery('raw_data', sqliteRecord);
      this.execSqlite(sqliteInsert.query, sqliteInsert.values)
        .then(success)
        .catch(errorf);
    };

    this.checkMysqlConnection(null, () => {
      // MySQL connected
      const mysqlRecord = this.filterRecordColumns(rawData, DatabaseService.MYSQL_RAW_DATA_COLUMNS);
      const mysqlInsert = this.buildInsertQuery('raw_data', mysqlRecord);
      this.execQuery(`${mysqlInsert.query} ON DUPLICATE KEY UPDATE transmission_id = VALUES(transmission_id)`, mysqlInsert.values,
        () => handleSQLiteInsert(true),
        (mysqlError) => {
          handleSQLiteInsert(false);
          this.logCriticalDatabaseIssue(`Error inserting into MySQL raw_data: ${mysqlError?.message ?? mysqlError}`, 'database', rawData.instrument_id);
        }
      );
    }, (err) => {
      // MySQL connection failed, insert into SQLite
      console.error('MySQL connection failed, insert into SQLite:', err.message);
      handleSQLiteInsert(false);
    });
  }

  resyncRawDataToMySQL(success: any, errorf: any) {
    const sqliteQuery = 'SELECT * FROM raw_data WHERE mysql_inserted = 0';

    this.execSqlite(sqliteQuery, [])
      .then((records) => {
        if (records.length === 0) {
          success('No raw data records to resync.');
          return;
        }

        this.processResyncRawDataRecords(records, success, errorf);
      })
      .catch((err: any) => {
        errorf('Error fetching raw data records from SQLite:', err);
      });
  }

  private processResyncRawDataRecords(records: any[], success: any, errorf: any) {
    records.forEach((record: any) => {
      // A transmission stored before identifiers existed is given one here,
      // so both copies carry the same identifier.
      this.ensureTransmissionIdentity({ ...record, store: 'sqlite' })
        .then(transmissionId => {
          const mysqlRecord = this.filterRecordColumns(
            { ...record, transmission_id: transmissionId, sha256: record.sha256 || transmissionSha256(record.data) },
            DatabaseService.MYSQL_RAW_DATA_COLUMNS
          );
          const mysqlInsert = this.buildInsertQuery('raw_data', mysqlRecord);
          this.execQuery(`${mysqlInsert.query} ON DUPLICATE KEY UPDATE transmission_id = VALUES(transmission_id)`, mysqlInsert.values,
            () => this.updateSQLiteAfterMySQLInsertRawData(record),
            (mysqlError: any) => {
              this.logCriticalDatabaseIssue(`Error resyncing raw_data ${record.id} to MySQL: ${mysqlError?.message ?? mysqlError}`, 'database', record.instrument_id);
            }
          );
        })
        .catch((error: any) => {
          this.logCriticalDatabaseIssue(`Error resyncing raw_data ${record.id} to MySQL: ${error?.message ?? error}`, 'database', record.instrument_id);
        });
    });

    success('Raw data resync process completed.');
  }

  private updateSQLiteAfterMySQLInsertRawData(record: any) {
    const updateQuery = 'UPDATE raw_data SET mysql_inserted = 1 WHERE id = ?';
    this.execSqlite(updateQuery, [record.id])
      .then(() => {
        console.log('Raw data record successfully resynced and updated in SQLite:', record.id);
      })
      .catch((error: any) => {
        console.error('Error updating SQLite after successful MySQL insert for raw data:', error);
      });
  }

  recordConsoleLogs(data: any, success: any, errorf: any) {
    const placeholders = Object.values(data).map(() => '?').join(',');
    const sqliteQuery = 'INSERT INTO app_log (' + Object.keys(data).join(',') + ') VALUES (' + placeholders + ')';
    const mysqlQuery = 'INSERT INTO app_log (' + Object.keys(data).join(',') + ') VALUES (' + placeholders + ')';

    // Insert into SQLite first
    this.execSqlite(sqliteQuery, Object.values(data))
      .then((sqliteResults: any) => {
        success({ sqlite: sqliteResults });
      })
      .catch((error: any) => {
        console.error('Error inserting into SQLite:', error);
        errorf(error);
      });

    // Independently try inserting into MySQL if connected
    this.checkMysqlConnection(null, () => {
      this.execQuery(mysqlQuery, Object.values(data), (mysqlResults) => {
        //console.log('MySQL Inserted:', mysqlResults);
      }, (mysqlError) => {
        this.logCriticalDatabaseIssue(`Error inserting into MySQL app_log: ${mysqlError?.message ?? mysqlError}`, 'database', data.instrument_id);
        errorf(mysqlError);
      });
    }, (mysqlError) => {
      //console.error('MySQL connection error:', mysqlError);
    });
  }

  async recordLogBatch(logs: any[]): Promise<void> {
    if (!logs || logs.length === 0) {
      return;
    }

    // WHY: previous version fanned out N parallel single-row inserts via IPC.
    // Under heavy logging this flooded the main process. Multi-row INSERTs
    // chunked under the SQLite parameter limit (999) keep IPC quiet and
    // sequential awaits between chunks let the renderer breathe.
    const batches = this.chunkArray(logs, DatabaseService.SQLITE_LOG_INSERT_BATCH_SIZE);
    for (const batch of batches) {
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',');
      const sqliteQuery = `INSERT INTO app_log (log, log_type, log_message, instrument_id, added_on, category, mysql_inserted) VALUES ${placeholders}`;
      const params: any[] = [];
      for (const log of batch) {
        params.push(log.message, log.type, log.message, log.instrumentId, log.timestamp, log.category ?? 'operational', 0);
      }
      try {
        await this.execSqlite(sqliteQuery, params);
      } catch (e) {
        console.error('SQLite log batch insert failed', e);
      }
    }

    await this.pruneLocalAppLogsIfDue();
    this.resyncAppLogToMySQL(() => { }, () => { });
  }

  private async pruneLocalAppLogsIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastLocalLogPruneAt < DatabaseService.LOCAL_LOG_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastLocalLogPruneAt = now;

    try {
      const automaticCutoff = this.buildActiveLogDateCutoff(
        this.sqliteLogDateExpression(),
        DatabaseService.LOCAL_LOG_RETENTION_ACTIVE_DAYS
      );
      await this.execSqlite(
        `DELETE FROM app_log WHERE ${this.sqliteLogDateExpression()} < ${automaticCutoff}`,
        []
      );
      const protectedCutoff = this.buildActiveLogDateCutoff(
        this.sqliteLogDateExpression(),
        DatabaseService.MINIMUM_LOG_RETENTION_ACTIVE_DAYS
      );
      await this.execSqlite(
        `DELETE FROM app_log
         WHERE id NOT IN (SELECT id FROM app_log ORDER BY id DESC LIMIT ?)
           AND ${this.sqliteLogDateExpression()} < ${protectedCutoff}`,
        [DatabaseService.LOCAL_LOG_MAX_ROWS]
      );
    } catch (error) {
      // Do not send retention failures back through the same log pipeline.
      console.error('Failed to prune local application logs:', error);
    }
  }

  public async previewApplicationLogCleanup(): Promise<ApplicationLogCleanupPreview> {
    const retainedActiveDays = DatabaseService.MINIMUM_LOG_RETENTION_ACTIVE_DAYS;
    const local = await this.getApplicationLogStoreCleanupPreview(
      query => this.execSqlite(query, []),
      this.sqliteLogDateExpression(),
      retainedActiveDays
    );

    let mysql = this.unavailableApplicationLogStorePreview();
    if (this.mysqlPool) {
      try {
        mysql = await this.getApplicationLogStoreCleanupPreview(
          query => this.execQueryPromise(query, []),
          'DATE(added_on)',
          retainedActiveDays
        );
      } catch {
        // Cleanup remains useful when the optional MySQL projection is offline.
      }
    }

    return { retainedActiveDays, local, mysql };
  }

  public async cleanupOldApplicationLogs(): Promise<ApplicationLogCleanupResult> {
    const retainedActiveDays = DatabaseService.MINIMUM_LOG_RETENTION_ACTIVE_DAYS;
    const localDate = this.sqliteLogDateExpression();
    const localCutoff = this.buildActiveLogDateCutoff(localDate, retainedActiveDays);
    const localResult = await this.execSqlite(
      `DELETE FROM app_log WHERE ${localDate} < ${localCutoff}`,
      []
    );

    let mysqlDeletedRows = 0;
    let mysqlAvailable = false;
    if (this.mysqlPool) {
      try {
        const mysqlCutoff = this.buildActiveLogDateCutoff('DATE(added_on)', retainedActiveDays);
        const mysqlResult = await this.execQueryPromise(
          `DELETE FROM app_log WHERE DATE(added_on) < ${mysqlCutoff}`,
          []
        );
        mysqlAvailable = true;
        mysqlDeletedRows = Number(mysqlResult?.affectedRows ?? 0);
      } catch {
        // Local housekeeping must still complete if optional MySQL is offline.
      }
    }

    return {
      localDeletedRows: Number(localResult?.changes ?? 0),
      mysqlDeletedRows,
      mysqlAvailable
    };
  }

  private async getApplicationLogStoreCleanupPreview(
    execute: (query: string) => Promise<any>,
    dateExpression: string,
    retainedActiveDays: number
  ): Promise<ApplicationLogStoreCleanupPreview> {
    const cutoff = this.buildActiveLogDateCutoff(dateExpression, retainedActiveDays);
    const rows = await execute(
      `SELECT COUNT(*) AS total_rows,
              COUNT(DISTINCT ${dateExpression}) AS active_days,
              COALESCE(SUM(CASE WHEN ${dateExpression} < ${cutoff} THEN 1 ELSE 0 END), 0) AS deletable_rows,
              ${cutoff} AS cutoff_date,
              MIN(${dateExpression}) AS oldest_date,
              MAX(${dateExpression}) AS newest_date
       FROM app_log`
    );
    const row = rows?.[0] ?? {};
    return {
      available: true,
      totalRows: Number(row.total_rows ?? 0),
      deletableRows: Number(row.deletable_rows ?? 0),
      activeDays: Number(row.active_days ?? 0),
      cutoffDate: row.cutoff_date ?? null,
      oldestDate: row.oldest_date ?? null,
      newestDate: row.newest_date ?? null
    };
  }

  private buildActiveLogDateCutoff(dateExpression: string, retainedActiveDays: number): string {
    const offset = Math.max(0, Math.trunc(retainedActiveDays) - 1);
    return `(SELECT active_date FROM (
      SELECT ${dateExpression} AS active_date
      FROM app_log
      WHERE added_on IS NOT NULL
      GROUP BY ${dateExpression}
      ORDER BY active_date DESC
      LIMIT 1 OFFSET ${offset}
    ) AS retained_log_dates)`;
  }

  private sqliteLogDateExpression(): string {
    // Existing SQLite rows store JavaScript Date values as Unix milliseconds,
    // while imports or older builds may contain formatted timestamps.
    return `date(CASE
      WHEN typeof(added_on) IN ('integer', 'real') THEN datetime(added_on / 1000, 'unixepoch')
      ELSE added_on
    END)`;
  }

  private unavailableApplicationLogStorePreview(): ApplicationLogStoreCleanupPreview {
    return {
      available: false,
      totalRows: 0,
      deletableRows: 0,
      activeDays: 0,
      cutoffDate: null,
      oldestDate: null,
      newestDate: null
    };
  }

  resyncAppLogToMySQL(success: any, errorf: any) {
    const sqliteQuery = 'SELECT * FROM app_log WHERE mysql_inserted = 0';

    this.execSqlite(sqliteQuery, [])
      .then((records) => {
        if (records.length === 0) {
          success('No app log records to resync.');
          return;
        }

        this.processResyncAppLogRecords(records, success, errorf);
      })
      .catch((err: any) => {
        errorf('Error fetching app log records from SQLite:', err);
      });
  }

  private processResyncAppLogRecords(records: any[], success: any, errorf: any) {
    const mysqlQuery = 'INSERT INTO app_log (log, log_type, log_message, instrument_id, added_on, category) VALUES ?';
    const batches = this.chunkArray(records, DatabaseService.MYSQL_APP_LOG_RESYNC_BATCH_SIZE);
    let batchIndex = 0;

    this.checkMysqlConnection(null, () => {
      const processNextBatch = () => {
        const batch = batches[batchIndex];
        if (!batch) {
          success('App log resync process completed.');
          return;
        }

        batchIndex++;
        const mysqlValues = batch.map(log => [
          log.log,
          log.log_type,
          log.log_message,
          log.instrument_id,
          log.added_on,
          log.category ?? 'operational'
        ]);
        this.execQuery(mysqlQuery, [mysqlValues],
          () => {
            const recordIds = batch.map(r => r.id);
            this.updateSQLiteAfterMySQLInsertAppLog(recordIds);
            processNextBatch();
          },
          (mysqlError) => {
            if (mysqlError) {
              // Logging this through app_log would create a recursive failure loop.
              console.error('Error inserting log batch into MySQL:', mysqlError);
            }
            errorf(mysqlError);
          }
        );
      };

      processNextBatch();
    }, () => {
      // Mysql not available
      errorf('MySQL not available');
    });
  }

  private chunkArray<T>(items: T[], batchSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      chunks.push(items.slice(i, i + batchSize));
    }
    return chunks;
  }

  private updateSQLiteAfterMySQLInsertAppLog(recordIds: any[]) {
    const placeholders = recordIds.map(() => '?').join(',');
    const updateQuery = `UPDATE app_log SET mysql_inserted = 1 WHERE id IN (${placeholders})`;
    this.execSqlite(updateQuery, recordIds)
      .then(() => {
        console.log('App log records successfully resynced and updated in SQLite:', recordIds.length);
      })
      .catch((error: any) => {
        console.error('Error updating SQLite after successful MySQL insert for app log:', error);
      });
  }

  fetchRecentLogs(instrumentId: string, limit: number = 200): Observable<any[]> {
    const subject = new Subject<any[]>();
    const query = `SELECT * FROM app_log
      WHERE instrument_id = ? AND (category IS NULL OR category = 'operational')
      ORDER BY id DESC LIMIT ?`;
    this.execSqlite(query, [instrumentId, limit])
      .then(rows => {
        // Defensive: ensure rows is an array before mapping
        if (!Array.isArray(rows)) {
          subject.next([]);
          subject.complete();
          return;
        }
        const logs = rows.map(row => ({
          type: row.log_type || 'info',
          message: row.log ?? '',
          instrumentId: row.instrument_id,
          timestamp: new Date(row.added_on),
          category: row.category || 'operational'
        }));
        logs.reverse();
        subject.next(logs);
        subject.complete();
      })
      .catch(err => {
        // Return empty array on error instead of propagating
        subject.next([]);
        subject.complete();
      });
    return subject.asObservable();
  }

  fetchRecentSystemLogs(limit: number = 200): Observable<any[]> {
    const subject = new Subject<any[]>();
    const query = `SELECT * FROM app_log
      WHERE log_type IN ('error', 'warn')
        AND (
          category IN ('system', 'database', 'migration')
          OR (instrument_id IS NULL AND (category IS NULL OR category = 'operational'))
        )
      ORDER BY id DESC LIMIT ?`;
    this.execSqlite(query, [limit])
      .then(rows => {
        const logs = Array.isArray(rows) ? rows.map(row => ({
          type: row.log_type || 'error',
          message: row.log ?? '',
          instrumentId: row.instrument_id,
          timestamp: new Date(row.added_on),
          category: row.category || 'operational'
        })).reverse() : [];
        subject.next(logs);
        subject.complete();
      })
      .catch(() => {
        subject.next([]);
        subject.complete();
      });
    return subject.asObservable();
  }

  /**
   * Fetches an order that is ready to be sent.
   */
  getOrdersToSend(success = null, errorf = null) {
    const query = 'SELECT * FROM orders WHERE result_status = 99 ORDER BY created_date ASC';

    this.execQuery(query, [],
      (results) => {
        if (results.length > 0) {
          success(results); // Assuming execQuery returns an array of results
        } else {
          success(null); // No orders to send
        }
      },
      (err: any) => {
        errorf(err);
      }
    );
  }

}
