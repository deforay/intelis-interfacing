import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service';

describe('DatabaseService result durability', () => {
  const createService = () => {
    // The constructor starts configuration subscriptions. These focused tests
    // exercise the persistence decision without starting the application runtime.
    const service = Object.create(DatabaseService.prototype) as DatabaseService;
    (service as any).recordTelemetryEvent = vi.fn().mockResolvedValue(true);
    (service as any).resultRecordedSubject = { next: vi.fn() };
    return service as any;
  };

  const sampleResult = {
    order_id: 'SAMPLE-001',
    test_id: 'VL',
    test_type: 'HIVVL',
    results: '1250',
    machine_used: 'ANALYZER-1'
  };

  it('stores a pending SQLite copy when MySQL is unavailable', async () => {
    const service = createService();
    service.checkMysqlConnection = vi.fn((_params, _success, failure) => failure(new Error('offline')));
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });

    await new Promise<void>((resolve, reject) => {
      service.recordTestResults(sampleResult, () => resolve(), reject);
    });

    const [query, values] = service.execSqlite.mock.calls[0];
    expect(query).toContain('`instrument_id`');
    expect(query).toContain('`mysql_inserted`');
    expect(values).toContain('ANALYZER-1');
    expect(values.at(-1)).toBe(0);
  });

  it('stamps the received time in the Settings time zone, the same in both databases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T22:15:09Z'));
    try {
      const service = createService();
      service.commonSettings = { timeZone: 'Asia/Kolkata' };
      service.checkMysqlConnection = vi.fn((_params, success) => success());
      service.execQuery = vi.fn((_query, _values, success) => success({ insertId: 1 }));
      service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });

      await new Promise<void>((resolve, reject) => {
        service.recordTestResults(sampleResult, () => resolve(), reject);
      });
      await new Promise<void>((resolve, reject) => {
        service.recordRawData({ data: 'H|\\^&', machine: 'ANALYZER-1', instrument_id: 'ANALYZER-1', sha256: 'f'.repeat(64) }, () => resolve(), reject);
      });

      const inserts = [...service.execSqlite.mock.calls, ...service.execQuery.mock.calls]
        .filter(([query]) => /^INSERT INTO `(orders|raw_data)`/.test(query));
      expect(inserts).toHaveLength(4);
      for (const [query, values] of inserts) {
        expect(query).toContain('`added_on`');
        expect(values).toContain('2026-09-25 03:45:09');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists recent results newest row first, whatever their received times say', async () => {
    const service = createService();
    // Before the upgrade SQLite stored UTC; after it, a zone west of UTC stores
    // an earlier wall time for a later result.
    const rows = [
      { id: 1, added_on: '2026-09-24 14:00:00' },
      { id: 2, added_on: '2026-09-24 10:01:00' },
    ];
    service.execSqlite = vi.fn(async (query: string) => {
      expect(query).toMatch(/ORDER BY id DESC LIMIT 1000$/);
      return [...rows].sort((a, b) => b.id - a.id);
    });

    const results: any[] = await firstValueFrom(service.fetchRecentResults(''));

    expect(results.map(row => row.id)).toEqual([2, 1]);
  });

  it('reports the newest local row as the last result received, even when MySQL copied it first', async () => {
    const service = createService();
    service.checkMysqlConnection = vi.fn((_params, success) => success());
    // In MySQL a result queued offline (A) was copied after a later one (B),
    // so A has the larger MySQL id. Locally B is the newer row.
    service.execQuery = vi.fn((query: string, _values, success) => {
      expect(query).not.toContain('added_on');
      success([{ lastLimsSync: '2026-09-24 10:05:00' }]);
    });
    const local = [
      { id: 7, added_on: '2026-09-24 09:00:00' },
      { id: 8, added_on: '2026-09-24 10:01:00' },
    ];
    service.execSqlite = vi.fn(async (query: string) => {
      expect(query).toMatch(/ORDER BY id DESC LIMIT 1$/);
      const newest = [...local].sort((a, b) => b.id - a.id)[0];
      return [{ lastResultReceived: newest.added_on }];
    });

    const times = await new Promise<any>((resolve, reject) =>
      service.fetchLastSyncTimes().subscribe({ next: resolve, error: reject }));

    expect(times).toEqual({ lastLimsSync: '2026-09-24 10:05:00', lastResultReceived: '2026-09-24 10:01:00' });
  });

  it('keeps a received time that is already given', async () => {
    const service = createService();
    service.commonSettings = { timeZone: 'UTC' };
    service.checkMysqlConnection = vi.fn((_params, _success, failure) => failure(new Error('offline')));
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });

    await new Promise<void>((resolve, reject) => {
      service.recordTestResults({ ...sampleResult, added_on: '2026-01-02 03:04:05' }, () => resolve(), reject);
    });

    expect(service.execSqlite.mock.calls[0][1]).toContain('2026-01-02 03:04:05');
  });

  it('marks the SQLite copy replicated only after MySQL succeeds', async () => {
    const service = createService();
    service.checkMysqlConnection = vi.fn((_params, success) => success());
    service.execQuery = vi.fn((_query, _values, success) => success({ insertId: 1 }));
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });

    await new Promise<void>((resolve, reject) => {
      service.recordTestResults(sampleResult, () => resolve(), reject);
    });

    expect(service.execQuery).toHaveBeenCalledOnce();
    expect(service.execQuery.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
    const localInsertValues = service.execSqlite.mock.calls[0][1];
    const ingestionId = localInsertValues.find(
      value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
    );
    expect(ingestionId).toBeTruthy();
    expect(service.execQuery.mock.calls[0][1]).toContain(ingestionId);
    expect(localInsertValues.at(-1)).toBe(0);
    expect(service.execSqlite.mock.calls[1][0]).toContain('SET mysql_inserted = 1');
    expect(service.execSqlite.mock.calls[1][1]).toEqual([1, 0, null]);
  });

  it('falls back to a pending local copy when the MySQL insert fails', async () => {
    const service = createService();
    service.checkMysqlConnection = vi.fn((_params, success) => success());
    service.execQuery = vi.fn((_query, _values, _success, failure) => failure(new Error('write failed')));
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });
    service.logCriticalDatabaseIssue = vi.fn();

    await new Promise<void>((resolve, reject) => {
      service.recordTestResults(sampleResult, () => resolve(), reject);
    });

    expect(service.execSqlite).toHaveBeenCalledOnce();
    expect(service.execSqlite.mock.calls[0][1].at(-1)).toBe(0);
  });

  it('does not attempt MySQL when the local durability write fails', async () => {
    const service = createService();
    const sqliteFailure = new Error('local disk unavailable');
    service.checkMysqlConnection = vi.fn((_params, success) => success());
    service.execQuery = vi.fn((_query, _values, success) => success({ insertId: 1 }));
    service.execSqlite = vi.fn().mockRejectedValue(sqliteFailure);

    const receivedError = await new Promise<Error>((resolve) => {
      service.recordTestResults(sampleResult, vi.fn(), resolve);
    });

    expect(service.execQuery).not.toHaveBeenCalled();
    expect(receivedError).toBe(sqliteFailure);
  });

  it('persists locally before attempting MySQL replication', async () => {
    const service = createService();
    service.checkMysqlConnection = vi.fn((_params, success) => success());
    service.execQuery = vi.fn((_query, _values, success) => success({ insertId: 1 }));
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });

    await new Promise<void>((resolve, reject) => {
      service.recordTestResults(sampleResult, resolve, reject);
    });

    // WHY: local-first ordering closes the crash window between databases.
    expect(service.execSqlite.mock.invocationCallOrder[0])
      .toBeLessThan(service.execQuery.mock.invocationCallOrder[0]);
  });

  it('records a failed test outcome without changing the order contract', async () => {
    const service = createService();
    service.checkMysqlConnection = vi.fn((_params, _success, failure) => failure(new Error('offline')));
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });

    await new Promise<void>((resolve, reject) => {
      service.recordTestResults({
        ...sampleResult,
        results: 'Failed',
        telemetry_machine_type: 'roche-cobas-5800',
        telemetry_protocol: 'hl7',
        telemetry_connection_mode: 'tcpserver'
      }, resolve, reject);
    });

    expect(service.recordTelemetryEvent).toHaveBeenCalledWith({
      eventType: 'test.processed',
      category: 'test',
      instrumentId: 'ANALYZER-1',
      machineType: 'roche-cobas-5800',
      protocol: 'hl7',
      connectionMode: 'tcpserver',
      testType: 'HIVVL',
      outcome: 'failed'
    });
    expect(service.execSqlite.mock.calls[0][0]).not.toContain('telemetry_machine_type');
  });

  it('uses analyzer completion time for the usage event when available', async () => {
    const service = createService();
    service.checkMysqlConnection = vi.fn((_params, _success, failure) => failure(new Error('offline')));
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 1 });

    await new Promise<void>((resolve, reject) => {
      service.recordTestResults({
        ...sampleResult,
        analysed_date_time: '2026-07-21 14:30:00',
        authorised_date_time: '2026-07-21 14:35:00'
      }, resolve, reject);
    });

    expect(service.recordTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: '2026-07-21 14:30:00' })
    );
  });

  it('retries a pending row with the same idempotency identity', async () => {
    const service = createService();
    const pendingRecord = {
      ...sampleResult,
      id: 42,
      instrument_id: 'ANALYZER-1',
      ingestion_id: 'stable-ingestion-id',
      mysql_inserted: 0
    };
    const remotelyStoredIds = new Set<string>();
    service.logCriticalDatabaseIssue = vi.fn();
    service.checkMysqlConnection = vi.fn((_params, success) => success());
    service.execQuery = vi.fn((_query, values, success) => {
      remotelyStoredIds.add(values[0][0].find(value => value === 'stable-ingestion-id'));
      success({ affectedRows: 1 });
    });
    service.execSqlite = vi.fn((query: string) => {
      if (query.startsWith('SELECT')) return Promise.resolve([pendingRecord]);
      return Promise.reject(new Error('status update interrupted'));
    });

    const resync = () => new Promise<void>((resolve, reject) => {
      service.resyncTestResultsToMySQL(() => resolve(), reject);
    });
    await resync();
    await resync();

    expect(service.execQuery).toHaveBeenCalledTimes(2);
    expect(service.execQuery.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
    expect(remotelyStoredIds).toEqual(new Set(['stable-ingestion-id']));
  });

  it('reads only the API result contract from pending SQLite rows', async () => {
    const service = createService();
    service.execSqlite = vi.fn().mockResolvedValue([{
      id: 19,
      order_id: 'SAMPLE-019',
      test_id: 'SAMPLE-019',
      results: 1250,
      test_unit: 'cp/mL',
      machine_used: null,
      instrument_id: 'ANALYZER-1',
      tested_by: null,
      authorised_date_time: null,
      result_accepted_date_time: null,
      raw_text: null,
      facility_id: 999
    }]);

    const page = await service.fetchPendingIntelisResults(500);
    const rows = page.rows;

    expect(service.execSqlite.mock.calls[0][0]).toContain('WHERE lims_sync_status = 0');
    expect(service.execSqlite.mock.calls[0][1]).toEqual([501]);
    expect(page.hasMore).toBe(false);
    expect(rows).toEqual([{
      id: 19,
      order_id: 'SAMPLE-019',
      test_id: 'SAMPLE-019',
      results: '1250',
      test_unit: 'cp/mL',
      machine_used: 'ANALYZER-1',
      instrument_id: 'ANALYZER-1',
      tested_by: null,
      authorised_date_time: null,
      result_accepted_date_time: null,
      raw_text: null
    }]);
    expect(rows[0]).not.toHaveProperty('facility_id');
  });

  it('defers an identifier group that crosses the server item boundary', async () => {
    const service = createService();
    const row = (id: number, orderId: string) => ({
      id,
      order_id: orderId,
      test_id: orderId,
      results: '1250',
      test_unit: 'cp/mL',
      machine_used: 'ANALYZER-1'
    });
    service.execSqlite = vi.fn().mockResolvedValue([
      row(1, 'SAMPLE-1'),
      row(2, 'SAMPLE-2'),
      row(3, 'SAMPLE-2')
    ]);

    const page = await service.fetchPendingIntelisResults(2);

    expect(page.rows.map(result => result.id)).toEqual([1]);
    expect(page.hasMore).toBe(true);
    expect(page.oversizedResultCount).toBe(0);
  });

  it('writes the server-provided status and queues its MySQL projection', async () => {
    const service = createService();
    service.execSqlite = vi.fn().mockResolvedValue({ changes: 2 });

    await service.applyIntelisResultAcknowledgements([
      { id: 7, outcome: 'accepted', limsSyncStatus: 1, reason: 'updated' },
      { id: 8, outcome: 'rejected', limsSyncStatus: 2, reason: 'no_matching_sample' }
    ]);

    const [query, values] = service.execSqlite.mock.calls[0];
    expect(query).toContain('lims_sync_status = CASE id');
    expect(query).toContain('mysql_status_synced = 0');
    expect(query).toContain('WHERE lims_sync_status = 0');
    expect(values).toEqual([7, 1, 8, 2, 7, 8]);
  });

  it('projects acknowledged statuses to MySQL by stable ingestion identity', async () => {
    const service = createService();
    service.mysqlPool = {};
    const pendingStatus = {
      id: 7,
      ingestion_id: 'stable-ingestion-id',
      lims_sync_status: 1,
      lims_sync_date_time: '2026-07-20 16:30:00'
    };
    service.execSqlite = vi.fn((query: string) => {
      if (query.includes('WHERE mysql_status_synced = 0')) return Promise.resolve([pendingStatus]);
      return Promise.resolve({ changes: 1 });
    });
    service.execQuery = vi.fn((_query, _values, success) => success({ affectedRows: 1 }));

    await new Promise<void>((resolve, reject) => {
      service.resyncIntelisStatusesToMySQL(() => resolve(), reject);
    });

    expect(service.execQuery.mock.calls[0][0]).toContain('CASE ingestion_id');
    expect(service.execQuery.mock.calls[0][1]).toContain('stable-ingestion-id');
    expect(service.execSqlite).toHaveBeenLastCalledWith(
      expect.stringContaining('SET mysql_status_synced = 1'),
      [7, 1, '2026-07-20 16:30:00']
    );
  });
});

describe('DatabaseService result webhook queue', () => {
  const createService = () => Object.create(DatabaseService.prototype) as any;

  it('reads pending rows as the published contract, with an ingestion ID on each', async () => {
    const service = createService();
    service.execSqlite = vi.fn(async (query: string) => {
      if (query.includes('WHERE result_webhook_status')) {
        return [
          { id: 3, ingestion_id: null, order_id: 'SAMPLE-003', results: '<40', result_status: 1, lims_sync_status: 0 },
          { id: 4, ingestion_id: 'ingest-4', order_id: 'SAMPLE-004', results: 'Invalid', result_status: 1 }
        ];
      }
      if (query.startsWith('UPDATE orders SET ingestion_id')) return { changes: 1 };
      return [{ ingestion_id: 'generated-3' }];
    });

    const page = await service.fetchPendingResultWebhookResults(1);

    const [query, values] = service.execSqlite.mock.calls[0];
    expect(query).toContain('WHERE result_webhook_status = ?');
    expect(query).not.toContain('lims_sync_status');
    expect(values).toEqual([0, 2]);
    expect(page.hasMore).toBe(true);
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({ id: 3, ingestion_id: 'generated-3', results: '<40' });
    expect(page.results[0]).not.toHaveProperty('lims_sync_status');
  });

  it('moves only still-pending rows to delivered', async () => {
    const service = createService();
    service.execSqlite = vi.fn().mockResolvedValue({ changes: 2 });

    await service.markResultWebhookDelivered([7, 8]);

    const [query, values] = service.execSqlite.mock.calls[0];
    expect(query).toContain('SET result_webhook_status = ?');
    expect(query).toContain('WHERE result_webhook_status = ? AND id IN (?,?)');
    expect(query).not.toContain('lims_sync_status');
    expect(values).toEqual([1, 0, 7, 8]);
  });
});

describe('DatabaseService telemetry durability', () => {
  const createService = () => {
    const service = Object.create(DatabaseService.prototype) as any;
    service.commonSettings = { labID: 'LAB-001' };
    service.store = { get: vi.fn().mockReturnValue('4.2.0') };
    service.mysqlPool = null;
    return service;
  };

  it('stores a PII-free event in SQLite when MySQL is unavailable', async () => {
    const service = createService();
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 7 });

    const stored = await service.recordTelemetryEvent({
      eventType: 'test.processed',
      category: 'test',
      instrumentId: 'ANALYZER-1',
      testType: 'HIVVL',
      outcome: 'success',
      occurredAt: '2026-07-21 14:30:00',
      orderId: 'MUST-NOT-BE-STORED',
      result: 'MUST-NOT-BE-STORED'
    } as any);

    expect(stored).toBe(true);
    const [query, values] = service.execSqlite.mock.calls[0];
    expect(query).toContain('INSERT INTO `telemetry_events`');
    expect(query).toContain('`event_id`');
    expect(query).toContain('`mysql_inserted`');
    expect(values).toContain('LAB-001');
    expect(values).toContain('ANALYZER-1');
    expect(values).toContain('2026-07-21 14:30:00');
    expect(values.some(value => typeof value === 'string' && value.startsWith('interface-'))).toBe(true);
    expect(values).not.toContain('MUST-NOT-BE-STORED');
  });

  it('replicates by stable event ID and marks the local row only after success', async () => {
    const service = createService();
    service.mysqlPool = {};
    service.execSqlite = vi.fn().mockResolvedValue({ lastID: 9 });
    service.execQuery = vi.fn((_query, _values, success) => success({ affectedRows: 1 }));

    await service.recordTelemetryEvent({
      eventType: 'instrument.connected',
      category: 'instrument',
      instrumentId: 'ANALYZER-1'
    });

    expect(service.execQuery).toHaveBeenCalledOnce();
    expect(service.execQuery.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE event_id');
    expect(service.execSqlite.mock.calls[1]).toEqual([
      'UPDATE telemetry_events SET mysql_inserted = 1 WHERE id IN (?)',
      [9]
    ]);
  });

  it('retries queued telemetry without changing its event identity', async () => {
    const service = createService();
    service.mysqlPool = {};
    const pending = {
      id: 11,
      event_id: '11111111-2222-4333-8444-555555555555',
      event_type: 'application.started',
      event_category: 'usage',
      occurred_at: '2026-07-20 10:00:00',
      outcome: 'started',
      event_count: 1,
      mysql_inserted: 0
    };
    service.execSqlite = vi.fn((query: string) => {
      if (query.includes('FROM telemetry_events')) return Promise.resolve([pending]);
      if (query.includes('FROM usage_statistics_daily')) return Promise.resolve([]);
      return Promise.resolve({ changes: 1 });
    });
    service.execQuery = vi.fn((_query, values, success) => success({ affectedRows: 1 }));

    await new Promise<void>((resolve, reject) => {
      service.resyncTelemetryToMySQL(() => resolve(), reject);
    });

    expect(service.execQuery.mock.calls[0][1][0][0]).toContain(pending.event_id);
    expect(service.execSqlite).toHaveBeenCalledWith(
      'UPDATE telemetry_events SET mysql_inserted = 1 WHERE id IN (?)',
      [11]
    );
  });

  it('does not fail application work when telemetry cannot be stored', async () => {
    const service = createService();
    service.execSqlite = vi.fn().mockRejectedValue(new Error('disk unavailable'));

    await expect(service.recordTelemetryEvent({
      eventType: 'application.started',
      category: 'usage'
    })).resolves.toBe(false);
  });

  it('copies absolute daily summaries to MySQL and marks the exact revision', async () => {
    const service = createService();
    service.mysqlPool = {};
    const summary = {
      id: 12,
      aggregate_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      activity_date: '2026-07-21',
      source_installation_id: 'interface-source-1',
      lab_id: 'LAB-001',
      instrument_id: 'ANALYZER-1',
      machine_type: 'cobas',
      test_type: 'HIVVL',
      total_tests: 25,
      successful_tests: 23,
      failed_tests: 2,
      first_test_at: '2026-07-21 08:00:00',
      last_test_at: '2026-07-21 17:00:00',
      revision: 25,
      updated_at: '2026-07-21 17:00:00'
    };
    service.execSqlite = vi.fn((query: string) => {
      if (query.includes('SELECT * FROM usage_statistics_daily')) return Promise.resolve([summary]);
      return Promise.resolve({ changes: 1 });
    });
    service.execQuery = vi.fn((_query, _values, success) => success({ affectedRows: 1 }));

    await new Promise<void>((resolve, reject) => {
      service.resyncUsageStatisticsDailyToMySQL(() => resolve(), reject);
    });

    expect(service.execQuery.mock.calls[0][0]).toContain('ON DUPLICATE KEY UPDATE');
    expect(service.execQuery.mock.calls[0][0]).toContain('VALUES(`revision`) >= `revision`');
    expect(service.execQuery.mock.calls[0][1][0][0]).toContain(summary.aggregate_id);
    expect(service.execSqlite).toHaveBeenLastCalledWith(
      'UPDATE usage_statistics_daily SET mysql_synced_revision = ? WHERE id = ? AND revision = ?',
      [25, 12, 25]
    );
  });

  it('exposes only allowed activity fields and acknowledges stable event IDs', async () => {
    const service = createService();
    service.execSqlite = vi.fn().mockResolvedValueOnce([{
      event_id: 'event-1',
      event_type: 'test.processed',
      event_category: 'test',
      occurred_at: '2026-07-21 14:30:00',
      event_count: 1,
      lab_id: 'MUST-NOT-LEAVE',
      source_installation_id: 'MUST-NOT-LEAVE'
    }]).mockResolvedValueOnce({ changes: 1 });

    const events = await service.fetchPendingIntelisActivity(100);
    expect(events[0]).not.toHaveProperty('lab_id');
    expect(events[0]).not.toHaveProperty('source_installation_id');
    await service.acknowledgeIntelisActivity(events);

    expect(service.execSqlite).toHaveBeenLastCalledWith(
      expect.stringContaining('event_id IN (?)'),
      ['event-1']
    );
  });

  it('acknowledges only the exact daily revision sent', async () => {
    const service = createService();
    service.execSqlite = vi.fn().mockResolvedValue({ changes: 1 });

    await service.acknowledgeIntelisUsageStatistics([{
      aggregate_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      revision: 17,
      outcome: 'updated'
    }]);

    expect(service.execSqlite).toHaveBeenCalledWith(
      expect.stringContaining('WHERE aggregate_id = ? AND revision = ?'),
      [17, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 17]
    );
  });
});

describe('DatabaseService log display', () => {
  it('returns stored logs as structured plain text', async () => {
    const service = Object.create(DatabaseService.prototype) as any;
    service.execSqlite = vi.fn().mockResolvedValue([{
      id: 7,
      instrument_id: 'ANALYZER-1',
      added_on: '2026-07-15T12:15:11.830Z',
      log_type: 'error',
      log: 'Connection timed out'
    }]);

    const entries = await firstValueFrom(
      service.fetchRecentLogs('ANALYZER-1') as ReturnType<DatabaseService['fetchRecentLogs']>
    );
    const [entry] = entries;

    expect(entry).toMatchObject({
      type: 'error',
      message: 'Connection timed out',
      instrumentId: 'ANALYZER-1',
      category: 'operational'
    });
    expect(entry.timestamp).toEqual(new Date('2026-07-15T12:15:11.830Z'));
  });

  it('restores recent categorized system warnings and errors', async () => {
    const service = Object.create(DatabaseService.prototype) as any;
    service.execSqlite = vi.fn().mockResolvedValue([{
      id: 8,
      instrument_id: 'ANALYZER-1',
      added_on: '2026-07-15T12:16:00.000Z',
      log_type: 'error',
      log: 'MySQL write failed',
      category: 'database'
    }]);

    const entries = await firstValueFrom(
      service.fetchRecentSystemLogs() as ReturnType<DatabaseService['fetchRecentSystemLogs']>
    );

    expect(service.execSqlite.mock.calls[0][0]).toContain("category IN ('system', 'database', 'migration')");
    expect(entries[0]).toMatchObject({
      type: 'error',
      message: 'MySQL write failed',
      category: 'database'
    });
  });

  it('prunes local logs at most once per day', async () => {
    const service = Object.create(DatabaseService.prototype) as any;
    service.lastLocalLogPruneAt = 0;
    service.execSqlite = vi.fn().mockResolvedValue({ changes: 0 });

    await service.pruneLocalAppLogsIfDue();
    await service.pruneLocalAppLogsIfDue();

    expect(service.execSqlite).toHaveBeenCalledTimes(2);
    expect(service.execSqlite.mock.calls[0][0]).toContain('LIMIT 1 OFFSET 29');
    expect(service.execSqlite.mock.calls[1][0]).toContain('LIMIT 1 OFFSET 6');
    expect(service.execSqlite.mock.calls[1][1]).toEqual([50000]);
  });

  it('previews cleanup using the seven most recent active log dates', async () => {
    const service = Object.create(DatabaseService.prototype) as any;
    service.mysqlPool = null;
    service.execSqlite = vi.fn().mockResolvedValue([{
      total_rows: 120,
      active_days: 10,
      deletable_rows: 30,
      cutoff_date: '2026-06-01',
      oldest_date: '2026-01-10',
      newest_date: '2026-07-20'
    }]);

    const preview = await service.previewApplicationLogCleanup();

    expect(service.execSqlite.mock.calls[0][0]).toContain('LIMIT 1 OFFSET 6');
    expect(service.execSqlite.mock.calls[0][0]).toContain("datetime(added_on / 1000, 'unixepoch')");
    expect(preview).toMatchObject({
      retainedActiveDays: 7,
      local: {
        available: true,
        totalRows: 120,
        deletableRows: 30,
        activeDays: 10,
        cutoffDate: '2026-06-01'
      },
      mysql: { available: false }
    });
  });

  it('cleans only dates older than the protected seven active dates', async () => {
    const service = Object.create(DatabaseService.prototype) as any;
    service.mysqlPool = {};
    service.execSqlite = vi.fn().mockResolvedValue({ changes: 30 });
    service.execQueryPromise = vi.fn().mockResolvedValue({ affectedRows: 25 });

    const result = await service.cleanupOldApplicationLogs();

    expect(service.execSqlite.mock.calls[0][0]).toContain('LIMIT 1 OFFSET 6');
    expect(service.execQueryPromise.mock.calls[0][0]).toContain('LIMIT 1 OFFSET 6');
    expect(result).toEqual({
      localDeletedRows: 30,
      mysqlDeletedRows: 25,
      mysqlAvailable: true
    });
  });
});
