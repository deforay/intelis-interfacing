import { describe, expect, it, vi } from 'vitest';
import { ResultWebhookSyncService } from './result-webhook-sync.service';

describe('ResultWebhookSyncService', () => {
  const pending = [
    { id: 7, ingestion_id: 'ingest-7', order_id: 'SAMPLE-007', results: '1250' },
    { id: 8, ingestion_id: 'ingest-8', order_id: 'SAMPLE-008', results: '<40' }
  ];

  function createService(options: { enabled?: boolean; submission?: any; hasMore?: boolean } = {}) {
    const database = {
      resultRecorded$: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      fetchPendingResultWebhookResults: vi.fn().mockResolvedValue({ results: pending, hasMore: options.hasMore ?? false }),
      markResultWebhookDelivered: vi.fn().mockResolvedValue(undefined),
      applyIntelisResultAcknowledgements: vi.fn(),
      resyncTestResultsToMySQL: vi.fn()
    };
    const webhook = {
      load: vi.fn().mockResolvedValue({ ok: true, data: { enabled: options.enabled ?? true } }),
      submit: vi.fn().mockResolvedValue(options.submission ?? { ok: true, data: { httpStatus: 200, delivered: 2 } })
    };
    const logging = { logSystemError: vi.fn() };
    const service = new ResultWebhookSyncService(database as any, webhook as any, logging as any);
    return { service, database, webhook, logging };
  }

  it('marks results delivered only after the receiver accepts them', async () => {
    const { service, database, webhook } = createService();

    const completed = await (service as any).synchronize();

    expect(completed).toBe(true);
    expect(webhook.submit).toHaveBeenCalledWith(pending);
    expect(database.markResultWebhookDelivered).toHaveBeenCalledWith([7, 8]);
  });

  it('leaves every result pending when the receiver refuses the batch', async () => {
    const { service, database, logging } = createService({
      submission: { ok: false, error: { code: 'http_500', message: 'The receiver answered HTTP 500.', httpStatus: 500 } }
    });

    const completed = await (service as any).synchronize();

    expect(completed).toBe(false);
    expect(database.markResultWebhookDelivered).not.toHaveBeenCalled();
    expect(logging.logSystemError).toHaveBeenCalledOnce();
  });

  it('does not repeat the same failure in the log on every retry', async () => {
    const { service, logging } = createService({
      submission: { ok: false, error: { code: 'connection_failed', message: 'Unable to reach the receiver.' } }
    });

    await (service as any).synchronize();
    await (service as any).synchronize();

    expect(logging.logSystemError).toHaveBeenCalledOnce();
  });

  it('reads nothing and sends nothing while forwarding is off', async () => {
    const { service, database, webhook } = createService({ enabled: false });

    const completed = await (service as any).synchronize();

    expect(completed).toBe(true);
    expect(database.fetchPendingResultWebhookResults).not.toHaveBeenCalled();
    expect(webhook.submit).not.toHaveBeenCalled();
  });

  it('lets accepted results past one the receiver refuses for its content', async () => {
    const { service, database, webhook } = createService();
    webhook.submit.mockImplementation(async (batch: any[]) => {
      if (batch.some(row => row.id === 7)) {
        return { ok: false, error: { code: 'http_422', message: 'Unprocessable', httpStatus: 422 } };
      }
      return { ok: true, data: { httpStatus: 200, delivered: batch.length } };
    });

    const completed = await (service as any).synchronize();

    expect(completed).toBe(false);
    expect(webhook.submit).toHaveBeenCalledTimes(3);
    expect(database.markResultWebhookDelivered).toHaveBeenCalledTimes(1);
    expect(database.markResultWebhookDelivered).toHaveBeenCalledWith([8]);
  });

  it('does not try results one by one when the receiver refuses everything', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, ingestion_id: `ingest-${index + 1}`, order_id: `S-${index}` }));
    const { service, database, webhook } = createService({
      submission: { ok: false, error: { code: 'http_400', message: 'Bad request', httpStatus: 400 } }
    });
    database.fetchPendingResultWebhookResults.mockResolvedValue({ results: rows, hasMore: false });

    const completed = await (service as any).synchronize();

    expect(completed).toBe(false);
    // The batch, then three single results, then it stops.
    expect(webhook.submit).toHaveBeenCalledTimes(4);
    expect(database.markResultWebhookDelivered).not.toHaveBeenCalled();
  });

  it('backs off without splitting when the receiver rejects the credentials', async () => {
    const { service, webhook } = createService({
      submission: { ok: false, error: { code: 'http_401', message: 'Unauthorized', httpStatus: 401 } }
    });

    await (service as any).synchronize();

    expect(webhook.submit).toHaveBeenCalledOnce();
  });

  it('keeps draining past a stuck result without waiting for the retry delay', async () => {
    const { service, webhook } = createService({ hasMore: true });
    webhook.submit.mockImplementation(async (batch: any[]) => batch.some(row => row.id === 7)
      ? { ok: false, error: { code: 'http_413', message: 'Too large', httpStatus: 413 } }
      : { ok: true, data: { httpStatus: 200, delivered: batch.length } });

    await (service as any).synchronize();

    expect((service as any).rerunRequested).toBe(true);
  });

  it('never touches InteLIS or MySQL delivery state', async () => {
    const { service, database } = createService();

    await (service as any).synchronize();

    expect(database.applyIntelisResultAcknowledgements).not.toHaveBeenCalled();
    expect(database.resyncTestResultsToMySQL).not.toHaveBeenCalled();
  });
});
