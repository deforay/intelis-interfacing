import { describe, expect, it } from 'vitest';
import {
  LEGACY_SETTINGS_EXPORT_SCHEMA_VERSION,
  SETTINGS_EXPORT_SCHEMA_VERSION,
  buildScheduledBackupFileName,
  normalizeBackupConfig,
  parseBackupTimestamp,
  parseSettingsExport,
  prepareSettingsForExport,
  selectBackupsToPrune,
  settingsFingerprint
} from '../../../shared/settings-backup';

function sampleSettings(): any {
  return {
    commonConfig: {
      labID: 'LAB001',
      mysqlHost: '127.0.0.1',
      mysqlPassword: 'ENC(secret)',
      encryptionKey: 'key'
    },
    lisApiConfig: {
      url: 'https://lis.example.test',
      credentials: { token: 'token' }
    },
    encryptionKey: 'top-level-key',
    intelisConnection: { encryptedCredential: 'ciphertext' },
    sourceInstallationId: 'source-id',
    resultWebhook: { enabled: true, url: 'http://engine.example.test/results', encryptedSecret: 'sealed' },
    storageCompacted: { sqlite: '2026-09-24T09:00:00.000Z' }
  };
}

describe('settings export preparation', () => {
  it('removes database and API credentials from a scrubbed export', () => {
    const settings = prepareSettingsForExport(sampleSettings(), { includeCredentials: false });

    expect(settings.commonConfig).toEqual({ labID: 'LAB001', mysqlHost: '127.0.0.1' });
    expect(settings.lisApiConfig.credentials).toBeUndefined();
    expect(settings.encryptionKey).toBeUndefined();
  });

  it('keeps credentials for an encrypted export', () => {
    const settings = prepareSettingsForExport(sampleSettings(), { includeCredentials: true });

    expect(settings.commonConfig.mysqlPassword).toBe('ENC(secret)');
    expect(settings.lisApiConfig.credentials).toEqual({ token: 'token' });
    // The key the stored ciphertexts are encrypted under has to travel with
    // them, or the restore cannot decrypt anything.
    expect(settings.encryptionKey).toBe('top-level-key');
  });

  it('never exports installation identity, in either mode', () => {
    [true, false].forEach(includeCredentials => {
      const settings = prepareSettingsForExport(sampleSettings(), { includeCredentials });
      expect(settings.intelisConnection).toBeUndefined();
      expect(settings.sourceInstallationId).toBeUndefined();
      expect(settings.resultWebhook).toBeUndefined();
      expect(settings.storageCompacted).toBeUndefined();
    });
  });

  it('scrubs the legacy commonSettings key as well as commonConfig', () => {
    const settings = prepareSettingsForExport(
      { commonSettings: { labID: 'LAB002', mysqlPassword: 'ENC(old)' } },
      { includeCredentials: false }
    );

    expect(settings.commonSettings).toEqual({ labID: 'LAB002' });
  });

  it('does not mutate the caller\'s settings object', () => {
    const original = sampleSettings();
    prepareSettingsForExport(original, { includeCredentials: false });

    expect(original.commonConfig.mysqlPassword).toBe('ENC(secret)');
    expect(original.sourceInstallationId).toBe('source-id');
  });
});

describe('settings export parsing', () => {
  it('reads a versioned plain export', () => {
    const parsed = parseSettingsExport({
      schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
      exportedAt: '2026-08-03T02:00:00.000Z',
      appVersion: '4.1.10',
      source: 'scheduled',
      encrypted: false,
      settings: { commonConfig: { labID: 'LAB001' } }
    });

    expect(parsed.encrypted).toBe(false);
    expect(parsed.settings.commonConfig.labID).toBe('LAB001');
  });

  it('reads a pre-versioning export as a bare settings object', () => {
    const parsed = parseSettingsExport({ commonConfig: { labID: 'LAB001' } });

    expect(parsed.schemaVersion).toBe(LEGACY_SETTINGS_EXPORT_SCHEMA_VERSION);
    expect(parsed.encrypted).toBe(false);
    expect(parsed.settings.commonConfig.labID).toBe('LAB001');
  });

  it('reports an encrypted export without exposing settings', () => {
    const parsed = parseSettingsExport({
      schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
      exportedAt: '2026-08-03T02:00:00.000Z',
      appVersion: '4.1.10',
      source: 'manual',
      encrypted: true,
      kdf: { name: 'scrypt', salt: 'c2FsdA==', keyLength: 32, N: 32768, r: 8, p: 1 },
      cipher: { name: 'aes-256-gcm', iv: 'aXY=', authTag: 'dGFn' },
      payload: 'cGF5bG9hZA=='
    });

    expect(parsed.encrypted).toBe(true);
    expect(parsed.settings).toBeUndefined();
    expect(parsed.envelope.payload).toBe('cGF5bG9hZA==');
  });

  it('refuses a file written by a newer format', () => {
    expect(() => parseSettingsExport({
      schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION + 1,
      encrypted: false,
      settings: {}
    })).toThrow(/newer version/i);
  });

  it('refuses a truncated encrypted file rather than half-importing', () => {
    expect(() => parseSettingsExport({
      schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
      encrypted: true,
      kdf: { name: 'scrypt', salt: 'c2FsdA==', keyLength: 32, N: 32768, r: 8, p: 1 },
      cipher: { name: 'aes-256-gcm', iv: 'aXY=', authTag: 'dGFn' }
    })).toThrow(/incomplete or corrupted/i);
  });

  it('refuses input that is not an object', () => {
    expect(() => parseSettingsExport(null)).toThrow(/expected a JSON object/i);
    expect(() => parseSettingsExport([])).toThrow(/expected a JSON object/i);
  });
});

describe('scheduled backup housekeeping', () => {
  it('names backups so lexical order is chronological', () => {
    const earlier = buildScheduledBackupFileName(new Date(2026, 7, 3, 2, 0, 0));
    const later = buildScheduledBackupFileName(new Date(2026, 7, 3, 14, 30, 5));

    expect(earlier).toBe('settings-20260803-020000.json');
    expect(later).toBe('settings-20260803-143005.json');
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('prunes same-week backups beyond the retention count', () => {
    const now = new Date(2026, 7, 5, 12, 0, 0);
    const files = [
      'settings-20260801-020000.json',
      'settings-20260802-020000.json',
      'settings-20260803-020000.json',
      'settings-20260804-020000.json'
    ];

    // All four fall in one week and one month, so only the newest survives the
    // weekly and monthly tiers; retention keeps the two newest.
    expect(selectBackupsToPrune(files, 2, now).sort()).toEqual([
      'settings-20260801-020000.json',
      'settings-20260802-020000.json'
    ]);
  });

  it('leaves unrelated files in the folder alone', () => {
    const files = ['notes.txt', 'interface-settings-20260803-020000.json', 'settings-20260801-020000.json'];

    expect(selectBackupsToPrune(files, 1, new Date(2026, 7, 5))).toEqual([]);
  });

  it('never prunes everything, even with a nonsense retention', () => {
    const now = new Date(2026, 7, 3, 12, 0, 0);
    const files = ['settings-20260801-020000.json', 'settings-20260802-020000.json'];

    expect(selectBackupsToPrune(files, 0, now)).toEqual(['settings-20260801-020000.json']);
    expect(selectBackupsToPrune(files, -5, now)).toEqual(['settings-20260801-020000.json']);
  });

  it('keeps a weekly copy so a burst of edits cannot evict older history', () => {
    const now = new Date(2026, 7, 5, 12, 0, 0);
    // A day of troubleshooting, plus one older configuration per week.
    const burst = Array.from({ length: 10 }, (_, i) =>
      `settings-20260805-${String(9 + i).padStart(2, '0')}0000.json`);
    const older = [
      'settings-20260729-020000.json',
      'settings-20260722-020000.json',
      'settings-20260715-020000.json'
    ];

    const pruned = selectBackupsToPrune([...burst, ...older], 5, now);

    // The stable configurations from previous weeks are what someone would
    // actually want to go back to, so they must outlive the burst.
    older.forEach(name => expect(pruned).not.toContain(name));
    expect(pruned.length).toBeGreaterThan(0);
  });

  it('thins old weeks down to one backup each', () => {
    const now = new Date(2026, 7, 5, 12, 0, 0);
    const files = [
      'settings-20260720-020000.json',
      'settings-20260721-020000.json',
      'settings-20260722-020000.json'
    ];

    const pruned = selectBackupsToPrune(files, 1, now);

    // Same week, so only its newest is worth keeping.
    expect(pruned.sort()).toEqual(['settings-20260720-020000.json', 'settings-20260721-020000.json']);
  });

  it('keeps a monthly copy well beyond the weekly window', () => {
    const now = new Date(2026, 7, 5, 12, 0, 0);
    const files = [
      'settings-20260105-020000.json',
      'settings-20260210-020000.json',
      'settings-20260315-020000.json'
    ];

    // Older than 12 weeks, so the weekly tier no longer applies, but each is
    // the only backup of its month.
    expect(selectBackupsToPrune(files, 1, now)).toEqual([]);
  });

  it('drops backups older than the monthly window', () => {
    const now = new Date(2026, 7, 5, 12, 0, 0);
    const files = ['settings-20230105-020000.json', 'settings-20260805-020000.json'];

    expect(selectBackupsToPrune(files, 1, now)).toEqual(['settings-20230105-020000.json']);
  });

  it('ignores a backup whose name carries no readable timestamp', () => {
    const files = ['settings-notatimestamp.json', 'settings-20260805-020000.json'];

    expect(selectBackupsToPrune(files, 1, new Date(2026, 7, 5))).toEqual([]);
  });

  it('dates a collision-suffixed backup by its timestamp', () => {
    expect(parseBackupTimestamp('settings-20260803-211611-2.json'))
      .toEqual(new Date(2026, 7, 3, 21, 16, 11));
    expect(parseBackupTimestamp('settings-20260803-211611.json'))
      .toEqual(new Date(2026, 7, 3, 21, 16, 11));
    expect(parseBackupTimestamp('notes.txt')).toBeNull();
  });

  it('falls back to defaults for missing or invalid backup config', () => {
    expect(normalizeBackupConfig(undefined)).toEqual({ enabled: true, interval: 'daily', retention: 10 });
    expect(normalizeBackupConfig({ interval: 'fortnightly', retention: 'lots' }))
      .toEqual({ enabled: true, interval: 'daily', retention: 10 });
    expect(normalizeBackupConfig({ enabled: false, interval: 'weekly', retention: 3 }))
      .toEqual({ enabled: false, interval: 'weekly', retention: 3 });
    expect(normalizeBackupConfig({ interval: 'monthly' }).interval).toBe('monthly');
  });

  it('migrates an hourly setting from an earlier build to the default', () => {
    // Hourly was offered briefly and removed: this configuration changes a few
    // times a year, so it only ever produced identical files.
    expect(normalizeBackupConfig({ enabled: true, interval: 'hourly', retention: 10 }).interval).toBe('daily');
  });

  it('clamps retention to a sane range', () => {
    expect(normalizeBackupConfig({ retention: 0 }).retention).toBe(1);
    expect(normalizeBackupConfig({ retention: 5000 }).retention).toBe(100);
  });
});

describe('settings fingerprint', () => {
  it('is identical for the same settings', () => {
    expect(settingsFingerprint(sampleSettings())).toBe(settingsFingerprint(sampleSettings()));
  });

  it('ignores key order, which electron-store does not preserve', () => {
    const a = { commonConfig: { labID: 'LAB001', mysqlHost: '127.0.0.1' }, lisApiConfig: { url: 'u' } };
    const b = { lisApiConfig: { url: 'u' }, commonConfig: { mysqlHost: '127.0.0.1', labID: 'LAB001' } };

    expect(settingsFingerprint(a)).toBe(settingsFingerprint(b));
  });

  it('changes when a setting actually changes', () => {
    const before = sampleSettings();
    const after = sampleSettings();
    after.commonConfig.mysqlHost = '10.0.0.9';

    expect(settingsFingerprint(before)).not.toBe(settingsFingerprint(after));
  });

  it('notices an added or removed instrument', () => {
    const before: any = { instrumentsConfig: [{ instrumentId: 'A' }] };
    const after: any = { instrumentsConfig: [{ instrumentId: 'A' }, { instrumentId: 'B' }] };

    expect(settingsFingerprint(before)).not.toBe(settingsFingerprint(after));
  });

  it('treats instrument order as meaningful', () => {
    const a: any = { instrumentsConfig: [{ instrumentId: 'A' }, { instrumentId: 'B' }] };
    const b: any = { instrumentsConfig: [{ instrumentId: 'B' }, { instrumentId: 'A' }] };

    expect(settingsFingerprint(a)).not.toBe(settingsFingerprint(b));
  });

  it('ignores bookkeeping that changes without the configuration changing', () => {
    const before: any = { commonConfig: { labID: 'LAB001' }, appVersion: '4.1.10', loggedin: false, appPath: '/a' };
    const after: any = { commonConfig: { labID: 'LAB001' }, appVersion: '4.1.11', loggedin: true, appPath: '/b' };

    // Otherwise every upgrade and every login would burn a retention slot.
    expect(settingsFingerprint(before)).toBe(settingsFingerprint(after));
  });

  it('ignores its own backup bookkeeping', () => {
    const before: any = { commonConfig: { labID: 'LAB001' }, lastSettingsBackupAt: '2026-08-01T00:00:00.000Z' };
    const after: any = { commonConfig: { labID: 'LAB001' }, lastSettingsBackupAt: '2026-08-02T00:00:00.000Z' };

    expect(settingsFingerprint(before)).toBe(settingsFingerprint(after));
  });

  it('distinguishes null from a missing value', () => {
    expect(settingsFingerprint({ a: null })).not.toBe(settingsFingerprint({}));
  });
});
