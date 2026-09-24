import { app, BrowserWindow, screen, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as mysql from 'mysql2';
import * as sqlite3 from '@vscode/sqlite3';

import * as log from 'electron-log/main';
import { setupSqlite } from './sqlite3helper.main';
import { appVersion } from './app-version.main';
import { registerIntelisConnectionIpc } from './intelis-connection.main';
import { registerResultWebhookIpc } from './result-webhook.main';
import { registerUpdateCheckIpc } from './update-check.main';
import {
  registerSettingsBackupIpc,
  startScheduledSettingsBackups,
  stopScheduledSettingsBackups
} from './settings-backup.main';

const args = process.argv.slice(1),
  serve = args.some(val => val === '--serve');

// The directory holding a laboratory's data is named here, not derived.
//
// WHY: Electron puts userData under app.getName(), which is the product name.
// Everything a laboratory has is inside it -- the settings store, interface.db,
// the automatic backups, the migrations that have been applied. Rename the
// product and every existing installation points at an empty folder: no
// instruments configured, no results, no history, and no error to explain it.
// Naming the directory instead of deriving it makes the product free to be
// called anything without a single lab noticing.
//
// The name is the one installations have always used and must not be changed,
// even when the product is renamed around it. scripts/test-data-directory.mjs
// says so again where someone editing this file will meet it.
//
// Must run before anything opens the store or the database: electron-store and
// the SQLite helper both resolve this path when they are constructed.
//
// Serving is left on Electron's default, so `npm start` does not read and write
// the data of an installation on the same machine. So is a run given an explicit
// --user-data-dir: the end-to-end tests hand Electron a disposable profile for
// exactly that reason, and a pin that overrode it would point them at a real
// laboratory's database and copy it into the test trace.
const DATA_DIRECTORY_NAME = 'vlsm-interfacing';
const profileChosenByCaller = args.some(argument => argument.startsWith('--user-data-dir'));
if (!serve && !profileChosenByCaller) {
  const dataDirectory = path.join(app.getPath('appData'), DATA_DIRECTORY_NAME);
  // Electron creates userData itself before it is first read, overridden or
  // not. Creating it here anyway costs nothing and does not rely on that
  // staying true of every platform and every version.
  fs.mkdirSync(dataDirectory, { recursive: true });
  app.setPath('userData', dataDirectory);
}

const Store = require('electron-store');
let win: BrowserWindow = null;
let store = new Store();
let sqlite3Obj: sqlite3.Database = null;
let sqliteDbName: string = 'interface.db';
const FORCE_MIGRATION_REPLAY_KEY = 'forceMigrationReplayRequested';
// Set by the background storage compaction when it freed space worth a rewrite.
const STORAGE_RECLAIM_PENDING_KEY = 'storageReclaimPending';
let tray: Tray = null;

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function registerProcessErrorLogging(): void {
  process.on('uncaughtException', (error) => {
    log.error(`[Main][UncaughtException] ${formatUnknownError(error)}`);
  });

  process.on('unhandledRejection', (reason) => {
    log.error(`[Main][UnhandledRejection] ${formatUnknownError(reason)}`);
  });
}

function getSQLiteDBConnection() {
  return sqlite3Obj;
}

function restartApp() {
  app.relaunch();
  app.exit();
}

// Idempotent SQLite errors that we can safely ignore when re-applying a migration
// against a partially-applied schema (e.g. ALTER TABLE ADD COLUMN on a column that
// already exists). Anything outside this set is treated as a real failure.
const SQLITE_REPLAY_ERROR_FRAGMENTS = [
  'duplicate column name',
  'already exists',
  'duplicate index',
  'duplicate constraint',
  'duplicate foreign key',
  'index already exists',
  'table already exists',
  'column already exists',
  'no such index',
  'no such constraint',
  'no such column',
  'no such table'
];

function isExpectedSqliteReplayError(err: Error | null): boolean {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return SQLITE_REPLAY_ERROR_FRAGMENTS.some(fragment => msg.includes(fragment));
}

// The core tables every healthy install must have. If any are missing while the
// versions table claims migrations have been applied, the bookkeeping is stale and
// we purge it so the runner re-applies the migrations from scratch.
const SQLITE_CORE_TABLES = ['orders', 'raw_data', 'app_log', 'telemetry_events', 'usage_statistics_daily'];

function sqliteRun(db: sqlite3.Database, sql: string, params: any[] = []): Promise<{ ok: boolean; err: Error | null }> {
  return new Promise((resolve) => {
    db.run(sql, params, function (err: Error | null) {
      resolve({ ok: !err, err });
    });
  });
}

function sqliteAll<T = any>(db: sqlite3.Database, sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve) => {
    db.all(sql, params, (err: Error | null, rows: T[]) => {
      resolve(err || !Array.isArray(rows) ? [] : rows);
    });
  });
}

function splitSqliteMigrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  let insideTrigger = false;

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;

    if (!buffer.trim() && /^CREATE\s+TRIGGER\b/i.test(trimmed)) {
      insideTrigger = true;
    }
    buffer += `${line}\n`;

    // WHY: semicolons inside BEGIN...END belong to one CREATE TRIGGER statement.
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

async function runSqliteMigrations(db, migrationsPath, forceReplay = false) {
  console.log('Running SQLite migrations from:', migrationsPath);

  // 1. Ensure versions table exists
  await sqliteRun(db, 'CREATE TABLE IF NOT EXISTS versions (version INTEGER PRIMARY KEY, filename TEXT, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)');

  // 2. Add filename column for backward compatibility (idempotent — old DBs may pre-date this column)
  await sqliteRun(db, 'ALTER TABLE versions ADD COLUMN filename TEXT');

  // 3. Get migration files
  if (!fs.existsSync(migrationsPath)) {
    log.error(`SQLite migration directory not found: ${migrationsPath}`);
    return;
  }

  const migrationFiles = fs.readdirSync(migrationsPath)
    .filter(file => file.endsWith('.sql'))
    .sort();

  if (migrationFiles.length === 0) {
    log.warn('No SQLite migration files found');
    return;
  }

  // 4. Self-heal stale bookkeeping. If the versions table claims migrations are
  //    applied but the core tables don't actually exist, the prior runner recorded
  //    a "success" after silently swallowing statement errors. Purge those rows so
  //    the migrations re-run instead of being skipped forever.
  const presentTables = new Set(
    (await sqliteAll<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table'"))
      .map(row => row.name)
  );
  const missingCoreTables = SQLITE_CORE_TABLES.filter(name => !presentTables.has(name));
  if (missingCoreTables.length > 0) {
    log.warn(`SQLite core tables missing (${missingCoreTables.join(', ')}); purging stale versions rows so migrations re-run`);
    const purge = await sqliteRun(db, 'DELETE FROM versions');
    if (!purge.ok) {
      log.error(`Failed to purge stale versions rows: ${purge.err?.message}`);
    }
  }

  // 5. Get applied migrations (return empty set on error)
  const appliedFilenames = forceReplay
    ? new Set<string>()
    : new Set(
      (await sqliteAll<{ filename: string }>(db, 'SELECT filename FROM versions WHERE filename IS NOT NULL'))
        .map(row => row.filename)
    );

  if (forceReplay) {
    console.log('SQLite force replay requested; every migration file will be attempted');
  }

  // 6. Run migrations. Real per-statement failures leave that migration's
  //    versions row absent so the next launch retries, but remaining statements
  //    are still attempted to repair as much of the schema as possible.
  let successCount = 0;
  for (const file of migrationFiles) {
    if (appliedFilenames.has(file)) {
      continue;
    }

    console.log(`Applying SQLite migration: ${file}`);
    const filePath = path.join(migrationsPath, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    const statements = splitSqliteMigrationStatements(sql);

    let migrationFailed = false;
    for (const statement of statements) {
      const { ok, err } = await sqliteRun(db, statement);
      if (ok) continue;

      if (isExpectedSqliteReplayError(err)) {
        console.log(`SQLite migration ${file} replay note: ${err?.message}`);
        continue;
      }

      log.error(`SQLite migration ${file} failed: ${err?.message}\nStatement: ${statement}`);
      migrationFailed = true;
    }

    if (migrationFailed) {
      log.error(`SQLite migration ${file} did NOT complete cleanly; leaving versions row absent so next launch retries`);
      continue;
    }

    const version = parseInt(file.split('.')[0], 10);
    const insert = await sqliteRun(db, 'INSERT OR IGNORE INTO versions (version, filename) VALUES (?, ?)', [version, file]);
    if (!insert.ok) {
      log.error(`Failed to record SQLite migration ${file} as applied: ${insert.err?.message}`);
      continue;
    }

    console.log(`✅ SQLite migration ${file} completed (${statements.length} statements)`);
    successCount++;
  }

  console.log(`SQLite migrations: ${successCount} processed`);
}


function createUniversalMySQLConfig(baseConfig: any) {
  return {
    ...baseConfig,
    // Connection settings (valid for both pools and connections)
    ssl: false,                    // Disable SSL to avoid cert issues
    insecureAuth: true,           // Allow insecure auth for older versions
    supportBigNumbers: true,      // Handle large numbers properly
    bigNumberStrings: true,       // Return big numbers as strings

    // Connection-specific timeout (valid for connections)
    connectTimeout: 10000,        // 10 seconds to connect

    // Date handling (consistent across versions)
    dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],

    // Character set (important for MySQL 5.x compatibility)
    charset: 'utf8mb4',

    // SQL mode handling (MySQL 5.x vs 8.x differences)
    typeCast: function (field: any, next: any) {
      // Handle different data types consistently
      if (field.type === 'BIT' && field.length === 1) {
        return field.buffer()[0] === 1;
      }
      return next();
    }
  };
}

function createUniversalMySQLPoolConfig(baseConfig: any) {
  return {
    ...createUniversalMySQLConfig(baseConfig),
    // Pool-specific settings
    // acquireTimeout: 10000,        // 10 seconds to get connection from pool
    // timeout: 600,                 // Query timeout (pool-specific)
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0
  };
}


// Daily recovery snapshot with 7-file rotation. SQLite's online backup API
// includes committed WAL transactions while presenting one consistent database
// image, which a direct copy of interface.db cannot guarantee after a crash.
async function backupSqliteDb(db: sqlite3.Database): Promise<void> {
  let temporaryTarget: string | null = null;
  try {
    const dbPath = path.join(app.getPath('userData'), sqliteDbName);
    if (!fs.existsSync(dbPath)) {
      return;
    }

    // A newly-created database has nothing useful to recover yet. Avoid
    // producing a misleading backup before its first migrations run.
    const applicationTables = await sqliteAll<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
    );
    if (applicationTables.length === 0) {
      return;
    }

    const backupDir = path.join(app.getPath('userData'), 'backups');
    await fs.promises.mkdir(backupDir, { recursive: true });

    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    // Keep legacy .bak files intact on upgrade; the normal seven-file rotation
    // ages them out after verified snapshots have replaced the recovery window.
    const target = path.join(backupDir, `${sqliteDbName}.${stamp}.snapshot.bak`);
    if (!fs.existsSync(target)) {
      temporaryTarget = `${target}.tmp-${process.pid}`;
      await fs.promises.rm(temporaryTarget, { force: true });
      await createOnlineSqliteBackup(db, temporaryTarget);
      await validateSqliteBackup(temporaryTarget);
      await fs.promises.rename(temporaryTarget, target);
      temporaryTarget = null;
      log.info(`SQLite backup written: ${target}`);
    }

    // Rotate — keep only the most recent 7 daily backups
    const backups = (await fs.promises.readdir(backupDir))
      .filter(name => name.startsWith(`${sqliteDbName}.`) && name.endsWith('.bak'))
      .sort();
    while (backups.length > 7) {
      const oldest = backups.shift();
      if (oldest) {
        await fs.promises.unlink(path.join(backupDir, oldest));
        log.info(`Pruned old SQLite backup: ${oldest}`);
      }
    }
  } catch (err) {
    // Backup is best-effort — never block startup if it fails
    log.error(`SQLite backup failed: ${formatUnknownError(err)}`);
  } finally {
    if (temporaryTarget) {
      await fs.promises.rm(temporaryTarget, { force: true }).catch(() => undefined);
    }
  }
}

function createOnlineSqliteBackup(db: sqlite3.Database, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let backup: sqlite3.Backup;
    try {
      backup = db.backup(target, (initializationError) => {
        if (initializationError) {
          reject(initializationError);
          return;
        }

        backup.step(-1, (stepError, completed) => {
          if (stepError) {
            reject(stepError);
          } else if (completed || backup.completed) {
            resolve();
          } else {
            reject(new Error('SQLite backup stopped before completion'));
          }
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function validateSqliteBackup(backupPath: string): Promise<void> {
  const backupDb = await new Promise<sqlite3.Database>((resolve, reject) => {
    const openedDb = new sqlite3.Database(backupPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) reject(error);
      else resolve(openedDb);
    });
  });

  try {
    const validationRows = await sqliteAll<{ quick_check: string }>(backupDb, 'PRAGMA quick_check');
    if (validationRows[0]?.quick_check !== 'ok') {
      throw new Error('SQLite backup validation failed');
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      backupDb.close(error => error ? reject(error) : resolve());
    });
  }
}


async function copySqliteMigrationFiles(): Promise<void> {
  const sourceDir = path.join(__dirname, 'sqlite-migrations');
  const targetDir = path.join(app.getPath('userData'), 'sqlite-migrations');

  try {
    if (!fs.existsSync(sourceDir)) {
      log.error(`SQLite migration source directory not found: ${sourceDir}`);
      return;
    }

    if (!fs.existsSync(targetDir)) {
      await fs.promises.mkdir(targetDir, { recursive: true });
    }

    const files = await fs.promises.readdir(sourceDir);
    for (const file of files) {
      const sourceFile = path.join(sourceDir, file);
      const targetFile = path.join(targetDir, file);

      // Always overwrite to prevent stale migration scripts in userData.
      await fs.promises.copyFile(sourceFile, targetFile);
      console.log(`Synced SQLite migration file: ${file}`);
    }
  } catch (err) {
    log.error(`Error copying SQLite migration files: ${formatUnknownError(err)}`);
  }
}


async function copyMySQLMigrationFiles(): Promise<void> {
  const sourceDir = path.join(__dirname, 'mysql-migrations');
  const targetDir = path.join(app.getPath('userData'), 'mysql-migrations');

  try {
    if (!fs.existsSync(sourceDir)) {
      log.error(`MySQL migration source directory not found: ${sourceDir}`);
      return;
    }

    if (!fs.existsSync(targetDir)) {
      await fs.promises.mkdir(targetDir, { recursive: true });
    }

    const files = await fs.promises.readdir(sourceDir);
    for (const file of files) {
      const sourceFile = path.join(sourceDir, file);
      const targetFile = path.join(targetDir, file);

      // Always overwrite to prevent stale migration scripts in userData.
      await fs.promises.copyFile(sourceFile, targetFile);
      console.log(`Synced MySQL migration file: ${file}`);
    }
  } catch (err) {
    log.error(`Error copying MySQL migration files: ${formatUnknownError(err)}`);
  }
}


let loggingConfigured = false;

/**
 * Sends the log to the laboratory's log folder. Called at the very start, so
 * what happens before the window exists (migrations, a storage rewrite) is
 * logged there too.
 */
function configureLogging(): void {
  if (loggingConfigured) {
    return;
  }
  loggingConfigured = true;
  log.initialize();
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';

  const today = new Date();
  const dateString = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
  log.transports.file.fileName = `${dateString}.log`;
  // Named for the same reason userData is: electron-log's default directory is
  // the product name on macOS and Linux. Keeping the logs beside the database
  // means a rename cannot scatter them, and there is one folder to ask a
  // laboratory for when something needs explaining.
  log.transports.file.resolvePathFn = () =>
    path.join(app.getPath('userData'), 'logs', log.transports.file.fileName as string);
}

function createWindow(): BrowserWindow {
  const electronScreen = screen;
  const size = electronScreen.getPrimaryDisplay().workAreaSize;

  configureLogging();

  Store.initRenderer();
  store = new Store();

  store.set('appPath', path.join(app.getPath('userData'), '/', sqliteDbName));
  store.set('appVersion', appVersion());

  win = new BrowserWindow({
    x: 0,
    y: 0,
    fullscreenable: true,
    width: size.width,
    height: size.height,
    webPreferences: {
      nodeIntegration: true,
      allowRunningInsecureContent: serve,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });

  if (serve) {
    import('electron-debug').then(debug => {
      debug.default({ isEnabled: true, showDevTools: true });
    });

    import('electron-reloader').then(reloader => {
      const reloaderFn = (reloader as any).default || reloader;
      reloaderFn(module, { watchRenderer: false });
    });
    win.loadURL('http://localhost:4200');
  } else {
    let pathIndex = './browser/index.html';

    if (fs.existsSync(path.join(__dirname, '../dist/browser/index.html'))) {
      pathIndex = '../dist/browser/index.html';
    }

    const fullPath = path.join(__dirname, pathIndex);
    const url = `file://${path.resolve(fullPath).replace(/\\/g, '/')}`;
    win.loadURL(url);
  }

  win.on('closed', () => {
    win = null;
  });

  return win;
}

function openModal() {
  const modal = new BrowserWindow({ parent: win, modal: true, show: false });
  modal.loadURL('');
  modal.once('ready-to-show', () => {
    modal.show();
  });
}

ipcMain.on('openModal', (event, arg) => {
  openModal();
});

registerProcessErrorLogging();


try {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    app.quit();
  } else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }

  const mysqlPools: Record<string, any> = {}; // simple in-memory cache of pools

  function registerIpcHandlers() {
    registerIntelisConnectionIpc(store);
    registerResultWebhookIpc(store, getSQLiteDBConnection);
    registerUpdateCheckIpc();

    // Settings export/import and scheduled local backups. Owns the store
    // directly so passphrases and decrypted credentials never cross IPC.
    registerSettingsBackupIpc({
      store,
      appVersion: appVersion(),
      userDataPath: app.getPath('userData'),
      getWindow: () => win
    });

    startScheduledSettingsBackups({
      store,
      appVersion: appVersion(),
      userDataPath: app.getPath('userData'),
      getWindow: () => win
    });

    ipcMain.handle('getUserDataPath', () => {
      return app.getPath('userData');
    });

    ipcMain.handle('is-force-migration-replay-requested', () => {
      return store.get(FORCE_MIGRATION_REPLAY_KEY) === true;
    });

    ipcMain.handle('clear-force-migration-replay-request', () => {
      store.delete(FORCE_MIGRATION_REPLAY_KEY);
      return { success: true };
    });

    ipcMain.handle('mysql-create-pool', (event, config) => {
      const key = JSON.stringify(config);
      if (!mysqlPools[key]) {
        const universalConfig = createUniversalMySQLPoolConfig(config);
        try {
          mysqlPools[key] = mysql.createPool(universalConfig);
          mysqlPools[key].on('connection', (connection: any) => {
            console.log('MySQL connection established');
            const compatibilityQueries = [
              "SET SESSION sql_mode=(SELECT REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', ''))",
              "SET SESSION INTERACTIVE_TIMEOUT=600",
              "SET SESSION WAIT_TIMEOUT=600"
            ];
            compatibilityQueries.forEach(query => {
              connection.query(query, (err: any) => {
                if (err) {
                  console.warn(`Non-critical SQL mode warning: ${err.message}`);
                }
              });
            });
          });
          mysqlPools[key].on('error', (err: any) => {
            console.error('MySQL pool error:', err.message);
          });
        } catch (error) {
          console.error('Error creating MySQL pool:', error);
          throw error;
        }
      }
      return { status: 'ok' };
    });

    ipcMain.handle('mysql-query', (event, config, query: string, values?: any[]) => {
      const key = JSON.stringify(config);
      if (!mysqlPools[key]) {
        const universalConfig = createUniversalMySQLPoolConfig(config);
        mysqlPools[key] = mysql.createPool(universalConfig);
      }
      return new Promise((resolve, reject) => {
        mysqlPools[key].query(query, values ?? [], (err: any, results: any) => {
          if (err) {
            const errorInfo = {
              message: err.message,
              code: err.code,
              errno: err.errno,
              sqlState: err.sqlState,
              sqlMessage: err.sqlMessage,
              fatal: err.fatal
            };
            if (err.code === 'ER_NOT_SUPPORTED_AUTH_MODE') {
              console.error('MySQL Authentication Error - Try updating user auth method:', errorInfo);
            } else if (err.code === 'ECONNREFUSED') {
              console.error('MySQL Connection Refused - Check if MySQL is running:', errorInfo);
            } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
              console.error('MySQL Access Denied - Check credentials:', errorInfo);
            } else {
              console.error('MySQL Error:', errorInfo);
            }
            reject(err);
          } else {
            resolve(results);
          }
        });
      });
    });

    ipcMain.handle('mysql-test-connection', (event, config) => {
      return new Promise((resolve, reject) => {
        const universalConfig = createUniversalMySQLConfig(config);
        const testConnection = mysql.createConnection(universalConfig);
        testConnection.connect((err: any) => {
          if (err) {
            testConnection.destroy();
            reject({ success: false, error: err.message, code: err.code, version: 'unknown' });
          } else {
            testConnection.query('SELECT VERSION() as version', (versionErr: any, results: any) => {
              const version = results && results[0] ? results[0].version : 'unknown';
              testConnection.destroy();
              if (versionErr) {
                reject({ success: false, error: versionErr.message, version: version });
              } else {
                resolve({ success: true, message: 'Connection successful', version: version });
              }
            });
          }
        });
        setTimeout(() => {
          testConnection.destroy();
          reject({ success: false, error: 'Connection test timeout', code: 'TIMEOUT' });
        }, 15000);
      });
    });

    ipcMain.handle('dialog', (event, method, params) => {
      return dialog[method](params);
    });

    ipcMain.on('sqlite3-query', (event, sql: string, params: any, replyChannel: string) => {
      // WHY: this runs inside a native SQLite callback. If the renderer went
      // away while the query was in flight, sending to its destroyed webContents
      // throws from a context with no caller to catch it, taking down the main
      // process. A dropped reply is recoverable; an unhandled throw here is not.
      const respond = (payload: any) => {
        if (!replyChannel) {
          return;
        }
        try {
          if (event.sender.isDestroyed()) {
            return;
          }
          event.sender.send(replyChannel, payload);
        } catch (err) {
          log.error(`Failed to deliver SQLite reply on ${replyChannel}: ${formatUnknownError(err)}`);
        }
      };

      if (!replyChannel) {
        log.error('sqlite3-query invoked without reply channel');
        return;
      }

      if (!sqlite3Obj) {
        respond({ __sqliteError: true, message: 'SQLite database not initialized' });
        return;
      }

      const statementType = typeof sql === 'string'
        ? sql.trim().split(/\s+/)[0]?.toLowerCase()
        : '';
      const isSelectStatement = ['select', 'pragma', 'with', 'show'].includes(statementType);
      const safeParams = params ?? [];

      const handleError = (err: any) => {
        log.error(`SQLite query error: ${err?.message || err}`);
        respond({
          __sqliteError: true,
          message: err?.message || 'Unknown SQLite error'
        });
      };

      try {
        if (isSelectStatement) {
          sqlite3Obj.all(sql, safeParams, (err, rows) => {
            if (err) {
              handleError(err);
            } else {
              respond(rows ?? []);
            }
          });
        } else {
          sqlite3Obj.run(sql, safeParams, function runCallback(err) {
            if (err) {
              handleError(err);
            } else {
              respond({
                changes: this.changes,
                lastID: this.lastID
              });
            }
          });
        }
      } catch (err) {
        handleError(err);
      }
    });

    ipcMain.handle('log-info', (event, message: string, instrumentId: string | null = null) => {
      let scopedLogger = log.scope('app');
      if (instrumentId) {
        scopedLogger = log.scope(instrumentId);
      }
      scopedLogger.info(message);
    });

    ipcMain.handle('log-warning', (event, message: string, instrumentId: string | null = null) => {
      let scopedLogger = log.scope('app');
      if (instrumentId) {
        scopedLogger = log.scope(instrumentId);
      }
      scopedLogger.warn(message);
    });

    ipcMain.handle('log-error', (event, message: string, instrumentId: string | null = null) => {
      let scopedLogger = log.scope('app');
      if (instrumentId) {
        scopedLogger = log.scope(instrumentId);
      }
      scopedLogger.error(message);
    });

    ipcMain.handle('sqlite3-wal-checkpoint', () => {
      return new Promise((resolve, reject) => {
        if (!sqlite3Obj) {
          reject(new Error('SQLite database not initialized'));
          return;
        }

        sqlite3Obj.run('PRAGMA wal_checkpoint(PASSIVE)', function (err) {
          if (err) {
            log.error(`Error running SQLite WAL checkpoint: ${err.message || err}`);
            reject(err);
          } else {
            resolve({ success: true });
          }
        });
      });
    });

    // VACUUM rewrites the whole file, so it runs here, where no query
    // timeout applies, and the WAL is truncated after it so the space
    // really leaves the disk.
    // SQLite is never rewritten while the tool runs: results that arrive
    // meanwhile would wait on it. The rewrite is asked for here and done at
    // the next start, before any instrument can connect, now if the operator
    // chose to restart.
    ipcMain.handle('rewrite-sqlite-at-start', (_event, restartNow: boolean) => {
      store.set(STORAGE_RECLAIM_PENDING_KEY, { sqlite: new Date().toISOString() });
      if (restartNow) {
        setTimeout(() => restartApp(), 300);
      }
      return { success: true };
    });

    ipcMain.handle('force-rerun-migrations', async () => {
      store.set(FORCE_MIGRATION_REPLAY_KEY, true);

      const db = getSQLiteDBConnection();
      if (db) {
        // DELETE instead of DROP - cleaner, keeps table structure
        await new Promise<void>((resolve) => {
          db.run('DELETE FROM versions', () => resolve());
        });
      }

      // Ensure userData migrations are in sync before restart/replay.
      await copySqliteMigrationFiles();
      await copyMySQLMigrationFiles();

      setTimeout(() => restartApp(), 500);
      return { success: true };
    });

    ipcMain.handle('show-confirm-dialog', async (event, options) => {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      if (focusedWindow) {
        return dialog.showMessageBox(focusedWindow, options);
      }
      return dialog.showMessageBox(null, options);
    });
  }

  // VACUUM rewrites the whole file, and the WAL is truncated after it so the
  // space really leaves the disk.
  function vacuumSqlite(db: sqlite3.Database): Promise<void> {
    return new Promise((resolve, reject) => {
      db.run('VACUUM', (vacuumError) => {
        if (vacuumError) {
          log.error(`SQLite VACUUM failed: ${vacuumError.message || vacuumError}`);
          reject(vacuumError);
          return;
        }
        db.run('PRAGMA wal_checkpoint(TRUNCATE)', (checkpointError) => {
          if (checkpointError) {
            log.warn(`SQLite WAL truncate after VACUUM failed: ${checkpointError.message || checkpointError}`);
          }
          resolve();
        });
      });
    });
  }

  // The background compaction frees space inside the database but does not
  // rewrite it, as results may be arriving. It asks for the rewrite here
  // instead, at the next start, before the window exists and so before any
  // instrument can connect.
  /**
   * Returns the notice shown while it worked, still open: closing the only
   * window would quit the application, so it is closed once the main window
   * exists.
   */
  async function reclaimSpaceIfRequested(db: sqlite3.Database): Promise<BrowserWindow | null> {
    const pending = store.get(STORAGE_RECLAIM_PENDING_KEY);
    if (!pending?.sqlite) {
      return null;
    }
    // Asked once: a failed rewrite is logged, not retried at every start.
    store.delete(STORAGE_RECLAIM_PENDING_KEY);
    const notice = await showStartupNotice(
      'Tidying up the database',
      'Giving back the space freed by storage compaction. This takes a few seconds, and the Interface Tool opens when it is done.'
    );
    const started = Date.now();
    try {
      await vacuumSqlite(db);
      log.info(`Gave the space freed by storage compaction back to the disk in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (error) {
      log.error(`Could not give the space freed by storage compaction back to the disk: ${formatUnknownError(error)}`);
    }
    return notice;
  }

  /**
   * A small window with a moving bar, for work done at start before the main
   * window exists. Its page is a fixed string with no Node and no input in
   * it. Resolves once it is on screen, or with null if it could not be shown:
   * the work goes ahead either way.
   */
  async function showStartupNotice(title: string, detail: string): Promise<BrowserWindow | null> {
    const page = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>
        body { margin: 0; padding: 22px 26px; font: 14px -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; background: #fff; }
        h1 { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
        p { margin: 0 0 16px; color: #4b5563; line-height: 1.4; }
        .track { position: relative; height: 6px; overflow: hidden; border-radius: 3px; background: #e5e7eb; }
        .bar { position: absolute; width: 35%; height: 100%; border-radius: 3px; background: #1976d2; animation: slide 1.2s ease-in-out infinite; }
        @keyframes slide { from { left: -35%; } to { left: 100%; } }
      </style></head>
      <body><h1>${title}</h1><p>${detail}</p><div class="track"><div class="bar"></div></div></body></html>`;
    try {
      const notice = new BrowserWindow({
        width: 440,
        height: 150,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        center: true,
        show: false,
        title,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, javascript: false }
      });
      const shown = new Promise<void>(resolve => notice.once('ready-to-show', () => { notice.show(); resolve(); }));
      await notice.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
      await Promise.race([shown, new Promise(resolve => setTimeout(resolve, 2000))]);
      return notice;
    } catch (error) {
      log.warn(`Could not show the start-up notice: ${formatUnknownError(error)}`);
      return null;
    }
  }

  app.on('ready', async () => {
    configureLogging();
    try {
      // First, set up the SQLite database connection
      sqlite3Obj = await new Promise<sqlite3.Database>((resolve, reject) => {
        setupSqlite(store, (db, err) => {
          if (err) {
            log.error(`Error during SQLite setup: ${formatUnknownError(err)}`);
            return reject(err);
          }
          console.info('SQLite setup complete');
          resolve(db);
        });
      });

      // Snapshot the pre-migration database through SQLite itself so committed
      // WAL transactions are included in the daily recovery point.
      await backupSqliteDb(sqlite3Obj);

      // Then, copy and run the migrations
      const migrationsPath = path.join(app.getPath('userData'), 'sqlite-migrations');
      const forceMigrationReplay = store.get(FORCE_MIGRATION_REPLAY_KEY) === true;
      await copySqliteMigrationFiles();
      await copyMySQLMigrationFiles();
      await runSqliteMigrations(sqlite3Obj, migrationsPath, forceMigrationReplay);
      const startupNotice = await reclaimSpaceIfRequested(sqlite3Obj);

      // IMPORTANT: Register all IPC handlers BEFORE creating the window
      registerIpcHandlers();

      // Now that the database and IPC are ready, create the main window
      createWindow();
      if (startupNotice && !startupNotice.isDestroyed()) {
        startupNotice.destroy();
      }

      // Log app startup to both console and file
      const startupTime = new Date().toISOString();
      console.log(`\n${'='.repeat(80)}\n🚀 APPLICATION STARTED - ${startupTime}\n${'='.repeat(80)}\n`);

      let trayIconPath = path.join(__dirname, './browser/assets/icons/favicon.png');
      if (fs.existsSync(path.join(__dirname, '../dist/browser/assets/icons/favicon.png'))) {
        trayIconPath = path.join(__dirname, '../dist/browser/assets/icons/favicon.png');
      }
      try {
        // Desktop shells do not consistently constrain oversized tray images.
        // Keep the high-resolution asset for packaging, but use a native-sized
        // copy here so it cannot expand the menu bar or system tray.
        const icon = nativeImage.createFromPath(trayIconPath).resize({
          width: 16,
          height: 16,
          quality: 'best'
        });
        tray = new Tray(icon);
        const contextMenu = Menu.buildFromTemplate([
          { label: 'Show', click: () => { win.show(); } },
          { label: 'Minimize', click: () => { win.minimize(); } },
          { label: 'Quit', click: () => { app.quit(); } },
        ]);
        tray.setToolTip('Interface Tool');
        tray.setContextMenu(contextMenu);

        tray.on('click', () => {
          if (win) {
            if (win.isMinimized()) win.restore();
            if (!win.isVisible()) win.show();
            win.focus();
          }
        });

        console.log('Tray icon setup successful.');
      } catch (error) {
        console.error('Error setting up tray icon:', error);
      }

      // Quit when all windows are closed.
      app.on('window-all-closed', () => {
        // On OS X it is common for applications and their menu bar
        // to stay active until the user quits explicitly with Cmd + Q
        if (process.platform !== 'darwin') {
          app.quit();
        }
      });

      app.on('activate', () => {
        if (win === null) {
          createWindow();
        }
      });
    } catch (error) {
      log.error(`Failed to initialize the application: ${formatUnknownError(error)}`);
      // If initialization fails, quit the app to prevent it from running in a broken state
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    stopScheduledSettingsBackups();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    app.quit();
  });

} catch (e) {
  console.error('Error during initialization: ', e);
}
