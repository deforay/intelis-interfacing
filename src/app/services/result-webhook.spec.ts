import { describe, expect, it } from 'vitest';
import {
  buildResultWebhookPayload,
  isPlainHttpToAnotherHost,
  isValidResultWebhookBatch,
  normalizeResultWebhookUrl,
  planResultWebhookBatches,
  RESULT_WEBHOOK_RESULT_FIELDS,
  RESULT_WEBHOOK_SCHEMA_VERSION,
  resolveResultWebhookTarget,
  StoredResultWebhook,
  toResultWebhookResult
} from '../../../shared/result-webhook';

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    ingestion_id: 'f2b6c1d0-8c1e-4a53-9a0d-1f6f1f2a3b4c',
    instrument_id: 'ANALYZER-1',
    machine_used: 'ANALYZER-1',
    order_id: ' SAMPLE-012 ',
    test_id: 'SAMPLE-012',
    test_type: 'HIVVL',
    test_description: null,
    test_location: null,
    results: '<40',
    test_unit: 'cp/mL',
    result_status: 1,
    notes: null,
    tested_by: 'op1',
    repeated: 0,
    analysed_date_time: '2026-09-16 10:15:00',
    specimen_date_time: null,
    authorised_date_time: '2026-09-16 10:20:00',
    result_accepted_date_time: null,
    added_on: '2026-09-16 10:20:05',
    raw_text: 'R|1|^^^HIV|<40|cp/mL',
    // Local bookkeeping that must never reach a receiver.
    mysql_inserted: 1,
    lims_sync_status: 0,
    result_webhook_status: 0,
    ...overrides
  };
}

describe('result webhook payload', () => {
  it('publishes values exactly as stored, and nothing else', () => {
    const result = toResultWebhookResult(storedRow({ results: '1,25E+03', notes: 'Invalid run' }));

    expect(Object.keys(result)).toEqual([...RESULT_WEBHOOK_RESULT_FIELDS]);
    expect(result.order_id).toBe(' SAMPLE-012 ');
    expect(result.results).toBe('1,25E+03');
    expect(result.notes).toBe('Invalid run');
    expect(result).not.toHaveProperty('lims_sync_status');
    expect(result).not.toHaveProperty('result_webhook_status');
  });

  it('keeps a numeric-looking result a string', () => {
    const result = toResultWebhookResult(storedRow({ results: '0040' }));
    expect(result.results).toBe('0040');
  });

  it('wraps results in a versioned envelope', () => {
    const payload = buildResultWebhookPayload([toResultWebhookResult(storedRow())], {
      batchId: 'batch-1',
      sentAt: '2026-09-16T10:21:00.000Z',
      source: { application: 'intelis-interfacing', appVersion: '4.3.0', installationId: null, labId: 'LAB1', labName: null }
    });

    expect(payload.schemaVersion).toBe(RESULT_WEBHOOK_SCHEMA_VERSION);
    expect(payload.test).toBe(false);
    expect(payload.results).toHaveLength(1);
  });
});

describe('result webhook batching', () => {
  const rows = Array.from({ length: 5 }, (_, index) => toResultWebhookResult(storedRow({ id: index + 1 })));

  it('splits by item count without dropping or reordering', () => {
    const batches = planResultWebhookBatches(rows, { maxItems: 2, maxBodyBytes: 1_000_000 });
    expect(batches.map(batch => batch.map(row => row.id))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('still sends a single result that is larger than the byte limit, alone', () => {
    const large = toResultWebhookResult(storedRow({ id: 9, raw_text: 'x'.repeat(5_000) }));
    const batches = planResultWebhookBatches([rows[0], large, rows[1]], { maxItems: 50, maxBodyBytes: 2_000 });
    expect(batches.map(batch => batch.map(row => row.id))).toEqual([[1], [9], [2]]);
  });
});

describe('result webhook batch validation', () => {
  it('accepts rows built from storage', () => {
    expect(isValidResultWebhookBatch([toResultWebhookResult(storedRow())])).toBe(true);
  });

  it('rejects empty batches, unknown fields, duplicates and missing ingestion IDs', () => {
    const row = toResultWebhookResult(storedRow());
    expect(isValidResultWebhookBatch([])).toBe(false);
    expect(isValidResultWebhookBatch([{ ...row, password: 'x' }])).toBe(false);
    expect(isValidResultWebhookBatch([row, row])).toBe(false);
    expect(isValidResultWebhookBatch([{ ...row, ingestion_id: '' }])).toBe(false);
    expect(isValidResultWebhookBatch([{ ...row, results: 40 }])).toBe(false);
  });
});

describe('result webhook URL', () => {
  it('accepts http and https', () => {
    expect(normalizeResultWebhookUrl(' http://localhost:8081/results ')).toBe('http://localhost:8081/results');
    expect(normalizeResultWebhookUrl('https://engine.example.org/lab?site=1')).toBe('https://engine.example.org/lab?site=1');
  });

  it('rejects other schemes, embedded credentials and fragments', () => {
    expect(() => normalizeResultWebhookUrl('ftp://engine.example.org')).toThrow();
    expect(() => normalizeResultWebhookUrl('https://user:pass@engine.example.org')).toThrow();
    expect(() => normalizeResultWebhookUrl('https://engine.example.org/#x')).toThrow();
    expect(() => normalizeResultWebhookUrl('not a url')).toThrow();
  });

  it('flags plain HTTP only when it leaves this machine', () => {
    expect(isPlainHttpToAnotherHost('http://localhost:8081/')).toBe(false);
    expect(isPlainHttpToAnotherHost('http://127.0.0.1:8081/')).toBe(false);
    expect(isPlainHttpToAnotherHost('http://[::1]:8081/')).toBe(false);
    expect(isPlainHttpToAnotherHost('http://192.168.1.20:8081/')).toBe(true);
    expect(isPlainHttpToAnotherHost('https://192.168.1.20/')).toBe(false);
  });
});

describe('result webhook target and secret', () => {
  const stored: StoredResultWebhook = {
    schemaVersion: 1,
    enabled: true,
    url: 'https://engine.example.org/results',
    authType: 'bearer',
    username: '',
    activatedAt: '2026-09-16T10:00:00.000Z',
    encryptedSecret: 'sealed'
  };

  it('reuses the saved secret for the same type and origin, without reading it', () => {
    const target = resolveResultWebhookTarget(
      { enabled: true, url: 'https://engine.example.org/other-path', authType: 'bearer' },
      stored
    );
    expect(target.secret).toEqual({ kind: 'stored' });
  });

  it('never sends the saved secret to a different origin', () => {
    for (const url of ['https://attacker.example.net/results', 'http://engine.example.org/results', 'https://engine.example.org:8443/results']) {
      expect(() => resolveResultWebhookTarget({ enabled: true, url, authType: 'bearer' }, stored))
        .toThrow(/address changed/);
    }
  });

  it('never reuses a secret saved for another authentication type', () => {
    expect(() => resolveResultWebhookTarget({ enabled: true, url: stored.url, authType: 'apikey' }, stored))
      .toThrow(/Enter the receiver secret/);
  });

  it('uses a newly entered secret for any URL', () => {
    const target = resolveResultWebhookTarget(
      { enabled: true, url: 'https://new.example.org/', authType: 'apikey', secret: 'k3y-value' },
      stored
    );
    expect(target.secret).toEqual({ kind: 'provided', secret: 'k3y-value' });
  });

  it('rejects header values that cannot be sent reliably', () => {
    for (const secret of ['has space', 'line\nbreak', 'clé']) {
      expect(() => resolveResultWebhookTarget({ enabled: true, url: stored.url, authType: 'bearer', secret }, null))
        .toThrow(/visible ASCII/);
    }
    expect(resolveResultWebhookTarget(
      { enabled: true, url: stored.url, authType: 'basic', username: 'lab', secret: 'mot de passe é' },
      null
    ).secret.kind).toBe('provided');
  });

  it('requires a username without a colon for Basic authentication', () => {
    expect(() => resolveResultWebhookTarget({ enabled: true, url: stored.url, authType: 'basic', secret: 'p' }, null)).toThrow();
    expect(() => resolveResultWebhookTarget({ enabled: true, url: stored.url, authType: 'basic', username: 'a:b', secret: 'p' }, null)).toThrow();
  });

  it('needs no secret, and carries none, without authentication', () => {
    const target = resolveResultWebhookTarget({ enabled: false, url: 'http://localhost:8081/', authType: 'none', secret: 'ignored' }, stored);
    expect(target.secret).toEqual({ kind: 'none' });
  });
});
