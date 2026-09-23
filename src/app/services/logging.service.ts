import { Injectable, Injector, OnDestroy } from '@angular/core';
import { LogDisplayService, LogEntry } from './log-display.service';
import { ElectronService } from '../core/services';

export interface LogOptions {
  category?: LogEntry['category'];
  displayInConsole?: boolean;
  persist?: boolean;
}

let logEntrySeq = 0;

@Injectable({
  providedIn: 'root'
})
export class LoggingService implements OnDestroy {
  // WHY: the queue is fed from the instrument receive path, which can log far
  // faster than the 10s drain. If persistence ever stalls, an unbounded queue
  // grows until the renderer dies, so cap it and drop the oldest entries.
  private static readonly MAX_QUEUED_LOGS = 20000;
  // WHY: the receive path logs whole TCP chunks, up to about 64 KB each. The
  // entry cap alone still let a stalled queue hold over a gigabyte. The bytes
  // themselves are kept in raw_data, so a log line only needs their start.
  static readonly MAX_MESSAGE_LENGTH = 4096;
  // If a batch write hasn't returned in this long it is treated as lost, so a
  // single stuck write can't block every later batch for the rest of the session.
  private static readonly PROCESSING_STALL_TIMEOUT_MS = 180000;

  private logQueue: LogEntry[] = [];
  private isProcessing = false;
  private processingStartedAt = 0;
  private droppedLogCount = 0;
  private processingInterval = 10000; // Process queue every 10 seconds
  private databaseServicePromise: Promise<any> | null = null;
  private readonly queueProcessingTimer: ReturnType<typeof setInterval>;

  constructor(
    private injector: Injector,
    private logDisplayService: LogDisplayService,
    private electronService: ElectronService
  ) {
    this.queueProcessingTimer = setInterval(() => this.processQueue(), this.processingInterval);
  }

  ngOnDestroy(): void {
    clearInterval(this.queueProcessingTimer);
  }

  log(
    type: 'info' | 'success' | 'warn' | 'error' | 'verbose',
    message: string,
    instrumentId?: string,
    options: LogOptions = {}
  ) {
    message = LoggingService.capMessage(message);
    const logEntry: LogEntry = {
      id: ++logEntrySeq,
      type,
      message,
      instrumentId,
      timestamp: new Date(),
      category: options.category ?? 'operational',
      displayInConsole: options.displayInConsole ?? true
    };

    // Push to display immediately
    this.logDisplayService.log(logEntry);

    if (this.electronService?.isElectron) {
      if (type === 'error') {
        this.electronService.logError(message, instrumentId);
      } else if (type === 'warn') {
        this.electronService.logWarning(message, instrumentId);
      } else {
        this.electronService.logInfo(message, instrumentId);
      }
    }

    // WHY: internal/system failures should still be queryable after the fact
    // even when we intentionally suppress them from the live operator console.
    if (options.persist !== false) {
      this.logQueue.push(logEntry);
      if (this.logQueue.length > LoggingService.MAX_QUEUED_LOGS) {
        const overflow = this.logQueue.length - LoggingService.MAX_QUEUED_LOGS;
        this.logQueue.splice(0, overflow);
        this.droppedLogCount += overflow;
      }
    }
  }

  /**
   * The message, cut to MAX_MESSAGE_LENGTH characters with a note of how
   * much was left out.
   */
  static capMessage(message: string): string {
    if (typeof message !== 'string' || message.length <= LoggingService.MAX_MESSAGE_LENGTH) {
      return message;
    }
    const omitted = message.length - LoggingService.MAX_MESSAGE_LENGTH;
    return `${message.slice(0, LoggingService.MAX_MESSAGE_LENGTH)}… (${omitted} more characters not logged)`;
  }

  logSystemError(message: string, instrumentId?: string, displayInConsole: boolean = false) {
    this.log('error', message, instrumentId, {
      category: 'system',
      displayInConsole
    });
  }

  private async processQueue() {
    if (this.isProcessing) {
      // A write that never settles would otherwise latch this flag on and stop
      // the queue draining for the rest of the session. Let the next tick past
      // the stall window start a fresh batch; the stuck one still owns its own
      // slice of entries, so nothing is written twice.
      const stalledFor = Date.now() - this.processingStartedAt;
      if (stalledFor < LoggingService.PROCESSING_STALL_TIMEOUT_MS) {
        return;
      }
      console.error(`Log persistence stalled for ${stalledFor}ms; resuming queue processing`);
    }

    if (this.logQueue.length === 0) {
      return;
    }

    if (this.droppedLogCount > 0) {
      console.error(`Dropped ${this.droppedLogCount} queued log entries after exceeding the in-memory limit`);
      this.droppedLogCount = 0;
    }

    this.isProcessing = true;
    this.processingStartedAt = Date.now();
    const logsToProcess = this.logQueue.splice(0); // Process all logs in the queue

    try {
      const dbService = await this.getDatabaseService();
      await dbService.recordLogBatch(logsToProcess);
    } catch (error) {
      console.error('Failed to persist log batch:', error);
      // If persistence fails, you might want to add the logs back to the queue
      // this.logQueue.unshift(...logsToProcess);
    } finally {
      this.isProcessing = false;
    }
  }

  private async getDatabaseService(): Promise<any> {
    if (!this.databaseServicePromise) {
      // WHY: DatabaseService also logs operational failures. Lazy loading avoids
      // a circular module dependency during startup.
      this.databaseServicePromise = import('./database.service')
        .then(({ DatabaseService }) => this.injector.get(DatabaseService));
    }

    return this.databaseServicePromise;
  }
}
