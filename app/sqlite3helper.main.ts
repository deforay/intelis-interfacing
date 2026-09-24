import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log/main';
import * as Store from 'electron-store';
import * as sqlite3 from '@vscode/sqlite3';
import { appVersion } from './app-version.main';

let sqlitePath: string = null;
let sqliteDbName: string = 'interface.db';

function ensureDirectoryExistence(filePath: string) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

function setupSqlite(storeInstance: Store, callback: (db: sqlite3.Database, err?: Error) => void): void {
  try {
    if (!storeInstance) {
      throw new Error('storeInstance is null or undefined.');
    }

    sqlitePath = path.join(app.getPath('userData'), sqliteDbName);
    ensureDirectoryExistence(sqlitePath);

    // If the main DB file is missing but the WAL/SHM sidecars are still
    // around (e.g. someone deleted interface.db while the app was running on
    // Linux, leaving the sidecars orphaned on disk), purge the orphans before
    // we open a fresh DB at the same path. SQLite usually copes with mismatched
    // sidecars but this avoids any ambiguity.
    if (!fs.existsSync(sqlitePath)) {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${sqlitePath}${suffix}`;
        if (fs.existsSync(sidecar)) {
          try {
            fs.unlinkSync(sidecar);
            log.warn(`Removed orphaned SQLite sidecar: ${sidecar}`);
          } catch (cleanupErr) {
            log.error(`Failed to remove orphaned SQLite sidecar ${sidecar}: ${cleanupErr}`);
          }
        }
      }
    }

    // Enable verbose mode for better debugging
    sqlite3.verbose();

    // Create a new database connection
    const db = new sqlite3.Database(sqlitePath, (err) => {
      if (err) {
        log.error('Error opening database:', err);
        callback(null, err);
        return;
      }

      // Set pragmas for performance
      db.serialize(() => {
        // Enable WAL mode
        db.run("PRAGMA journal_mode = WAL");
        db.run("PRAGMA synchronous = NORMAL");  // Balance between performance and durability
        db.run("PRAGMA temp_store = MEMORY");   // Store temporary tables in memory
        db.run("PRAGMA cache_size = 10000");    // Increase cache size

        storeInstance.set('appPath', sqlitePath);
        storeInstance.set('appVersion', appVersion());
        log.info('SQLite database initialized at:', sqlitePath);

        callback(db); // Success
      });
    });
  } catch (err) {
    log.error('Failed to set up SQLite:', err);
    callback(null, err); // Failure
  }
}

export { setupSqlite };
