import { Injectable } from '@angular/core';

interface MySQLConnection {
  query: (q: string, args: any, cb: (err: any, res?: any) => void) => void;
  release: () => void;
}

interface MySQLPool {
  query: MySQLConnection['query'];
  getConnection: (cb: (err: any, conn: MySQLConnection) => void) => void;
  on: (event: string, handler: Function) => void;
}

interface MySQLClient {
  createPool: (config: any) => MySQLPool;
  createConnection: (config: any) => {
    connect: (cb: (err: any | null) => void) => void;
    query: (q: string, cb: (err: any, res?: any) => void) => void;
    destroy: () => void;
  };
}

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  // Generous enough for the slowest real statement here (log pruning and the
  // resync sweeps over large tables), while still bounding a lost reply.
  private static readonly SQLITE_QUERY_TIMEOUT_MS = 120_000;

  ipcRenderer: any;
  webFrame: any;
  childProcess: any;
  fs: any;
  mysql: MySQLClient;
  net: any;

  constructor() {
    const that = this;

    if (that.isElectron) {
      that.ipcRenderer = window.require('electron').ipcRenderer;
      that.webFrame = window.require('electron').webFrame;
      that.childProcess = window.require('child_process');
      that.fs = window.require('fs');
      that.net = window.require('net');

      // Simplified MySQL implementation
      that.mysql = {
        createPool: (config) => ({
          on: () => { },
          query: (q, args, cb) => this.executeQuery(config, q, args, cb),
          getConnection: (cb) => {
            const connection = {
              query: (q, args, cb2) => this.executeQuery(config, q, args, cb2),
              release: () => { }
            };
            cb(null, connection);
          }
        }),
        createConnection: (config) => ({
          connect: (cb) => this.testConnection(config, cb),
          query: (q, cb) => this.executeQuery(config, q, [], cb),
          destroy: () => { }
        })
      };
    }
  }

  private sanitizeConfig(config: any) {
    return {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit,
      waitForConnections: config.waitForConnections,
      queueLimit: config.queueLimit
    };
  }

  private createMySQLError(err: any): any {
    if (typeof err === 'string') {
      return { message: err, code: 'UNKNOWN_ERROR' };
    }

    if (err && typeof err === 'object') {
      return {
        message: err.message || 'MySQL error',
        code: err.code || 'UNKNOWN_ERROR'
      };
    }

    return { message: 'Unknown MySQL error', code: 'UNKNOWN_ERROR' };
  }

  private executeQuery(config: any, query: string, args: any, callback: (err: any, res?: any) => void) {
    try {
      this.ipcRenderer.invoke('mysql-query', this.sanitizeConfig(config), query, args)
        .then(res => callback(null, res))
        .catch(err => callback(this.createMySQLError(err)));
    } catch (error) {
      console.error('Error invoking IPC for MySQL query:', error);
      callback(this.createMySQLError(error));
    }
  }

  private testConnection(config: any, callback: (err: any) => void) {
    try {
      this.ipcRenderer.invoke('mysql-query', this.sanitizeConfig(config), 'SELECT 1')
        .then(() => callback(null))
        .catch(err => callback(this.createMySQLError(err)));
    } catch (error) {
      console.error('Error invoking IPC for MySQL connection:', error);
      callback(this.createMySQLError(error));
    }
  }

  get isElectron(): boolean {
    return !!(window && window.process && window.process.type);
  }

  getUserDataPath(): Promise<string> {
    return this.ipcRenderer.invoke('getUserDataPath');
  }

  isForceMigrationReplayRequested(): Promise<boolean> {
    return this.ipcRenderer.invoke('is-force-migration-replay-requested');
  }

  clearForceMigrationReplayRequest(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke('clear-force-migration-replay-request');
  }

  openDialog(method: any, config: any): any {
    this.ipcRenderer.invoke('dialog', method, config);
  }

  execSqliteQuery(sql: any, args?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const uniqueEvent = `sqlite3-reply-${Date.now()}-${Math.random()}`;

      // WHY: a reply that never arrives (main process restarted, renderer
      // reloaded mid-query, reply send threw) would otherwise leave both this
      // promise and its IPC listener alive forever. Callers that await this —
      // notably the log batch writer — would then stall permanently and grow
      // their queue without bound. Always settle, always unregister.
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.ipcRenderer.removeAllListeners(uniqueEvent);
        fn();
      };

      const timeoutHandle = setTimeout(() => {
        finish(() => reject(new Error(
          `SQLite query timed out after ${ElectronService.SQLITE_QUERY_TIMEOUT_MS}ms`
        )));
      }, ElectronService.SQLITE_QUERY_TIMEOUT_MS);

      this.ipcRenderer.once(uniqueEvent, (_, arg) => {
        if (arg && arg.__sqliteError) {
          finish(() => reject(new Error(arg.message || 'Unknown SQLite error')));
        } else {
          finish(() => resolve(arg));
        }
      });

      try {
        this.ipcRenderer.send('sqlite3-query', sql, args, uniqueEvent);
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  executeSqliteWalCheckpoint(): Promise<any> {
    return this.ipcRenderer.invoke('sqlite3-wal-checkpoint');
  }

  /**
   * Asks for the SQLite file to be rewritten without its free pages, so it
   * shrinks, at the next start. With `restartNow`, the tool restarts at once.
   */
  rewriteSqliteAtStart(restartNow: boolean): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke('rewrite-sqlite-at-start', restartNow);
  }

  // WHY: these are fire-and-forget. Without a catch, an IPC failure (main
  // process shutting down, window torn down mid-call) surfaces as an unhandled
  // rejection rather than a dropped log line.
  logInfo(message: string, instrumentId: string = null) {
    this.invokeQuietly('log-info', message, instrumentId);
  }

  logError(message: string, instrumentId: string = null) {
    this.invokeQuietly('log-error', message, instrumentId);
  }

  logWarning(message: string, instrumentId: string = null) {
    this.invokeQuietly('log-warning', message, instrumentId);
  }

  private invokeQuietly(channel: string, message: string, instrumentId: string | null): void {
    try {
      const result = this.ipcRenderer.invoke(channel, message, instrumentId);
      if (result && typeof result.catch === 'function') {
        result.catch(() => undefined);
      }
    } catch {
      // Losing a log line must never interrupt instrument processing.
    }
  }
}
