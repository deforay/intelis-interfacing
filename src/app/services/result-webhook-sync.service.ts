import { Injectable, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  planResultWebhookBatches,
  RESULT_WEBHOOK_CONTENT_REJECTION_STATUSES,
  RESULT_WEBHOOK_MAX_ITEMS,
  ResultWebhookResult
} from '../../../shared/result-webhook';
import { BACKGROUND_INTERVAL_MS } from '../constants/domain.constants';
import { DatabaseService } from './database.service';
import { LoggingService } from './logging.service';
import { ResultWebhookService } from './result-webhook.service';

/**
 * Forwards stored results to the configured webhook. Independent of InteLIS
 * delivery and of MySQL: it reads and writes only result_webhook_status, so
 * turning it on changes nothing about how results reach an LIS today.
 */
@Injectable({ providedIn: 'root' })
export class ResultWebhookSyncService implements OnDestroy {
  private static readonly MAX_REFUSALS_BEFORE_ANY_DELIVERY = 3;
  private started = false;
  private inFlight = false;
  private rerunRequested = false;
  private retryDelayMs: number = BACKGROUND_INTERVAL_MS.RESULT_API_RETRY_INITIAL;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resultRecordedSubscription: Subscription | null = null;
  private lastFailureCode: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly webhook: ResultWebhookService,
    private readonly logging: LoggingService
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.resultRecordedSubscription = this.database.resultRecorded$.subscribe(() => this.schedule(1_000));
    this.schedule(1_000);
  }

  /** Called after Settings saves, so a change takes effect without waiting for the idle interval. */
  wake(): void {
    this.retryDelayMs = BACKGROUND_INTERVAL_MS.RESULT_API_RETRY_INITIAL;
    this.schedule(1_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.resultRecordedSubscription?.unsubscribe();
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  private async run(): Promise<void> {
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }

    this.timer = null;
    this.inFlight = true;
    let retryRequired = false;

    try {
      retryRequired = !(await this.synchronize());
    } catch (error) {
      retryRequired = true;
      this.logFailure('local_sync_error', `Result forwarding could not read or update its local queue: ${error?.message ?? error}`);
    } finally {
      this.inFlight = false;
    }

    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.schedule(1_000);
      return;
    }

    if (retryRequired) {
      const delay = this.retryDelayMs;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, BACKGROUND_INTERVAL_MS.RESULT_API_RETRY_MAX);
      this.schedule(delay);
      return;
    }

    this.retryDelayMs = BACKGROUND_INTERVAL_MS.RESULT_API_RETRY_INITIAL;
    this.schedule(BACKGROUND_INTERVAL_MS.RESULT_API_IDLE);
  }

  /** Resolves false when anything is left for a retry. */
  private async synchronize(): Promise<boolean> {
    const state = await this.webhook.load();
    if (!state.ok || !state.data?.enabled) return true;

    const page = await this.database.fetchPendingResultWebhookResults(RESULT_WEBHOOK_MAX_ITEMS);
    if (page.results.length === 0) return true;

    let everythingDelivered = true;
    let progressed = false;
    for (const batch of planResultWebhookBatches(page.results)) {
      const response = await this.webhook.submit(batch);
      if (response.ok) {
        await this.database.markResultWebhookDelivered(batch.map(result => result.id));
        progressed = true;
        continue;
      }

      // Nothing in a refused batch is marked: every row stays pending.
      this.logFailure(response.error?.code || 'result_forwarding_failed', response.error?.message);
      if (batch.length === 1 || !RESULT_WEBHOOK_CONTENT_REJECTION_STATUSES.includes(response.error?.httpStatus)) {
        // The receiver is unreachable or refuses everything: stop and back off.
        return false;
      }
      if (!(await this.deliverIndividually(batch))) return false;
      everythingDelivered = false;
      progressed = true;
    }

    if (everythingDelivered) {
      if (this.lastFailureCode) console.log('Result forwarding recovered');
      this.lastFailureCode = null;
    }
    // Continue straight on while results are moving. A page that moves nothing
    // falls back to the retry delay, so a stuck result cannot cause a busy loop.
    if (page.hasMore && progressed) this.rerunRequested = true;
    return everythingDelivered;
  }

  /**
   * The receiver refused a batch for its content. Sending the results one at a
   * time lets the ones it accepts through, while the one it will not take stays
   * pending and visible instead of holding back every later result.
   *
   * Resolves false when the refusals look like the receiver rather than the
   * results, so a misconfigured receiver is not sent every row one by one.
   */
  private async deliverIndividually(batch: ResultWebhookResult[]): Promise<boolean> {
    let delivered = 0;
    let consecutiveRefusals = 0;
    for (const result of batch) {
      const response = await this.webhook.submit([result]);
      if (response.ok) {
        await this.database.markResultWebhookDelivered([result.id]);
        delivered++;
        consecutiveRefusals = 0;
        continue;
      }
      consecutiveRefusals++;
      if (delivered === 0 && consecutiveRefusals >= ResultWebhookSyncService.MAX_REFUSALS_BEFORE_ANY_DELIVERY) {
        return false;
      }
    }
    return delivered > 0;
  }

  private logFailure(code: string, message?: string): void {
    if (this.lastFailureCode === code) return;
    this.lastFailureCode = code;
    this.logging.logSystemError(
      `Result forwarding needs attention (${code}): ${message || 'The request will be retried automatically.'}`,
      undefined,
      true
    );
  }
}
