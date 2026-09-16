// Settings export/backup format, shared by the Electron main process (which
// writes and reads the files) and the renderer (which shows what a file
// contains before importing it).
//
// Kept free of `fs`, `crypto` and Electron imports so it can be bundled into
// the renderer. Anything needing those lives in app/settings-backup.main.ts.

/**
 * Bumped whenever the envelope or the shape of `settings` changes in a way an
 * older build cannot read. Files written before versioning existed are bare
 * settings objects with no envelope; those are reported as version 0.
 */
export const SETTINGS_EXPORT_SCHEMA_VERSION = 1;

/** Pre-versioning exports: the settings object was the whole file. */
export const LEGACY_SETTINGS_EXPORT_SCHEMA_VERSION = 0;

/**
 * Enforced in main before writing, and in the renderer so the user is told
 * before the save dialog rather than after choosing a filename.
 */
export const MIN_PASSPHRASE_LENGTH = 8;

/**
 * No hourly option: this configuration changes a few times a year, so an
 * hourly schedule only produces identical files. See settingsFingerprint —
 * a backup is written only when something actually changed, which makes the
 * interval a ceiling on how often a change can be captured rather than a
 * promise to write a file.
 */
export type SettingsBackupInterval = 'daily' | 'weekly' | 'monthly';

export interface SettingsBackupConfig {
  enabled: boolean;
  interval: SettingsBackupInterval;
  /** How many automatic backups to keep. Older ones are pruned after a write. */
  retention: number;
}

export const DEFAULT_SETTINGS_BACKUP_CONFIG: SettingsBackupConfig = {
  enabled: true,
  interval: 'daily',
  retention: 10
};

export const SETTINGS_BACKUP_CONFIG_KEY = 'backupConfig';

/** Directory under userData that automatic backups are written to. */
export const SETTINGS_BACKUP_DIR_NAME = 'settings-backups';

export const SETTINGS_BACKUP_INTERVAL_MS: Record<SettingsBackupInterval, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000
};

/** Timestamp of the last backup actually written. Shown to the user. */
export const LAST_SETTINGS_BACKUP_AT_KEY = 'lastSettingsBackupAt';

/**
 * Timestamp of the last time a backup was considered. Drives scheduling,
 * which must advance even when nothing was written — otherwise an unchanged
 * configuration would be re-checked on every tick forever.
 */
export const LAST_SETTINGS_BACKUP_CHECK_AT_KEY = 'lastSettingsBackupCheckAt';

/** Fingerprint of the last backup written, used to skip identical ones. */
export const LAST_SETTINGS_BACKUP_FINGERPRINT_KEY = 'lastSettingsBackupFingerprint';

export interface SettingsExportEnvelopeBase {
  schemaVersion: number;
  /** ISO timestamp, for humans reading a folder of backups. */
  exportedAt: string;
  /** App version that wrote the file, to explain shape differences later. */
  appVersion: string;
  /** How the file was produced, so an unattended file is distinguishable. */
  source: 'manual' | 'scheduled';
  encrypted: boolean;
}

export interface PlainSettingsExport extends SettingsExportEnvelopeBase {
  encrypted: false;
  /** Credentials are absent: see scrubSensitiveSettings. */
  settings: Record<string, any>;
}

export interface EncryptedSettingsExport extends SettingsExportEnvelopeBase {
  encrypted: true;
  kdf: {
    name: 'scrypt';
    salt: string;
    keyLength: number;
    N: number;
    r: number;
    p: number;
  };
  cipher: {
    name: 'aes-256-gcm';
    iv: string;
    authTag: string;
  };
  /** Base64 ciphertext of JSON.stringify(settings). */
  payload: string;
}

export type SettingsExport = PlainSettingsExport | EncryptedSettingsExport;

/**
 * Never leaves this machine, in either export mode.
 *
 * The installation identity is what the Intelis backend uses to attribute
 * results and usage. Copying it to a second machine produces two installs
 * claiming to be the same one, which breaks result idempotency — so unlike
 * credentials, there is no "include these" option.
 *
 * `resultWebhook` is bound to this machine for the same reason: its secret is
 * sealed to this computer's keychain, and its activation decides which of this
 * database's results are forwarded. Restored elsewhere, it would switch
 * forwarding on for a database it never looked at.
 */
export const INSTALLATION_IDENTITY_KEYS = ['intelisConnection', 'sourceInstallationId', 'resultWebhook'] as const;

/** Credential fields, omitted unless the export is encrypted with a passphrase. */
const SENSITIVE_COMMON_CONFIG_FIELDS = ['mysqlPassword', 'encryptionKey'] as const;

/**
 * Top-level `encryptionKey` is the key `mysqlPassword` and the LIS credentials
 * are encrypted under. A full export has to carry it or the restored copies
 * are undecryptable on the target machine; a scrubbed export must not.
 */
const SENSITIVE_TOP_LEVEL_FIELDS = ['encryptionKey'] as const;

/** Deep clone via JSON: settings are plain JSON already (they live in a JSON store). */
function cloneSettings(settings: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(settings ?? {}));
}

/**
 * Removes the installation identity. Applied to every export and to every
 * import, so neither writing nor reading a crafted file can clone an install.
 */
export function stripInstallationIdentity<T extends Record<string, any>>(settings: T): T {
  INSTALLATION_IDENTITY_KEYS.forEach(key => {
    delete settings[key];
  });
  return settings;
}

/**
 * Removes credentials from a settings snapshot, in place.
 *
 * Stored settings use `commonConfig`; `commonSettings` was the older name and
 * is still covered so an old file that gets imported and re-exported cannot
 * leak credentials through the legacy key.
 */
export function scrubSensitiveSettings<T extends Record<string, any>>(settings: T): T {
  if (!settings) {
    return settings;
  }

  SENSITIVE_TOP_LEVEL_FIELDS.forEach(field => {
    delete settings[field];
  });

  [settings.commonConfig, settings.commonSettings]
    .filter(Boolean)
    .forEach((commonSettings: Record<string, any>) => {
      SENSITIVE_COMMON_CONFIG_FIELDS.forEach(field => {
        delete commonSettings[field];
      });
    });

  if (settings.lisApiConfig?.credentials) {
    delete settings.lisApiConfig.credentials;
  }

  return settings;
}

/**
 * Builds the settings object to export. Identity is always stripped;
 * credentials survive only when the caller is producing an encrypted file.
 */
export function prepareSettingsForExport(
  rawSettings: Record<string, any>,
  options: { includeCredentials: boolean }
): Record<string, any> {
  const settings = stripInstallationIdentity(cloneSettings(rawSettings));
  return options.includeCredentials ? settings : scrubSensitiveSettings(settings);
}

/**
 * Serialises settings with object keys in a stable order.
 *
 * electron-store does not guarantee insertion order across writes, so plain
 * JSON.stringify would report a change every time an unrelated key moved,
 * defeating the point of comparing at all. Arrays keep their order, which is
 * meaningful for instrument lists.
 */
function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Identifies a configuration by content, so an unchanged one is not written
 * again. Retention then holds the last N *distinct* configurations rather than
 * N copies of the current one — which is the difference between being able to
 * go back a year and only being able to go back N days.
 *
 * Volatile bookkeeping is excluded: these change without the configuration
 * meaningfully changing, and would make every backup look distinct.
 */
export function settingsFingerprint(settings: Record<string, any>): string {
  const meaningful = { ...settings };
  ['appPath', 'appVersion', 'loggedin', LAST_SETTINGS_BACKUP_AT_KEY,
    LAST_SETTINGS_BACKUP_CHECK_AT_KEY, LAST_SETTINGS_BACKUP_FINGERPRINT_KEY]
    .forEach(key => delete meaningful[key]);
  return stableStringify(meaningful);
}

/** `settings-20260803-021500.json` — lexical order matches chronological order. */
export function formatBackupTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

const SCHEDULED_BACKUP_PREFIX = 'settings-';
const SCHEDULED_BACKUP_SUFFIX = '.json';

export function buildScheduledBackupFileName(date: Date): string {
  return `${SCHEDULED_BACKUP_PREFIX}${formatBackupTimestamp(date)}${SCHEDULED_BACKUP_SUFFIX}`;
}

export function buildManualExportFileName(date: Date, encrypted: boolean): string {
  const suffix = encrypted ? '-full' : '';
  return `interface-settings-${formatBackupTimestamp(date)}${suffix}${SCHEDULED_BACKUP_SUFFIX}`;
}

export function isScheduledBackupFileName(fileName: string): boolean {
  return fileName.startsWith(SCHEDULED_BACKUP_PREFIX) && fileName.endsWith(SCHEDULED_BACKUP_SUFFIX);
}

// Thinning tiers applied underneath the user's "backups to keep" number.
// Fixed rather than configurable: they exist to stop a burst of edits from
// evicting older history, which is not something a lab should have to reason
// about. Worst case is retention + 12 + 24 files of about a kilobyte each.
export const BACKUP_WEEKLY_TIER_WEEKS = 12;
export const BACKUP_MONTHLY_TIER_MONTHS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

// Trailing -2, -3 … are collision suffixes for backups written in the same
// second; the timestamp is still what dates the file.
const BACKUP_NAME_PATTERN =
  /^settings-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.json$/;

/**
 * Recovers the time a backup was written from its name. Local time, matching
 * how the name was built. Returns null for anything unrecognised, which the
 * caller treats as "do not touch".
 */
export function parseBackupTimestamp(fileName: string): Date | null {
  const match = BACKUP_NAME_PATTERN.exec(fileName);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match.map(Number) as unknown as number[];
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date;
}

function weekBucket(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS / 7);
}

function monthBucket(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/**
 * Given the files in the backup directory, returns the ones to delete.
 *
 * Three tiers survive: the newest `retention` backups, then the newest backup
 * of each of the last few weeks, then the newest of each of the last couple of
 * years of months. Without the older tiers a burst of edits — initial setup,
 * or an afternoon of troubleshooting — would fill every slot with variations
 * of today and evict the stable configuration worth going back to.
 *
 * Because backups are only written when settings change, the weekly and
 * monthly tiers select among files that already exist rather than causing new
 * ones. Files this function does not recognise are left alone: the directory
 * belongs to the user, and deleting something we did not write would be a bad
 * surprise.
 */
export function selectBackupsToPrune(
  fileNames: string[],
  retention: number,
  now: Date = new Date()
): string[] {
  const keepRecent = Math.max(1, Math.floor(retention));

  const dated = fileNames
    .filter(isScheduledBackupFileName)
    .map(name => ({ name, date: parseBackupTimestamp(name) }))
    .filter((entry): entry is { name: string; date: Date } => entry.date != null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const keep = new Set<string>();

  dated.slice(0, keepRecent).forEach(entry => keep.add(entry.name));

  // Entries are newest-first, so the first one seen in a bucket is its newest.
  const seenWeeks = new Set<number>();
  const seenMonths = new Set<string>();

  for (const entry of dated) {
    const ageDays = (now.getTime() - entry.date.getTime()) / DAY_MS;

    if (ageDays <= BACKUP_WEEKLY_TIER_WEEKS * 7) {
      const bucket = weekBucket(entry.date);
      if (!seenWeeks.has(bucket)) {
        seenWeeks.add(bucket);
        keep.add(entry.name);
      }
    }

    if (monthsBetween(entry.date, now) <= BACKUP_MONTHLY_TIER_MONTHS) {
      const bucket = monthBucket(entry.date);
      if (!seenMonths.has(bucket)) {
        seenMonths.add(bucket);
        keep.add(entry.name);
      }
    }
  }

  return dated.filter(entry => !keep.has(entry.name)).map(entry => entry.name);
}

export function normalizeBackupConfig(raw: any): SettingsBackupConfig {
  // An 'hourly' value from a build that offered it falls through to the
  // default, along with anything else unrecognised.
  const interval: SettingsBackupInterval =
    raw?.interval === 'weekly' || raw?.interval === 'monthly' || raw?.interval === 'daily'
      ? raw.interval
      : DEFAULT_SETTINGS_BACKUP_CONFIG.interval;

  const parsedRetention = Number(raw?.retention);
  const retention = Number.isFinite(parsedRetention)
    ? Math.min(100, Math.max(1, Math.floor(parsedRetention)))
    : DEFAULT_SETTINGS_BACKUP_CONFIG.retention;

  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS_BACKUP_CONFIG.enabled,
    interval,
    retention
  };
}

export interface ParsedSettingsExport {
  schemaVersion: number;
  encrypted: boolean;
  /** Present only for unencrypted files. Encrypted payloads need a passphrase. */
  settings?: Record<string, any>;
  envelope?: EncryptedSettingsExport;
  exportedAt?: string;
  appVersion?: string;
}

function looksLikeEnvelope(raw: any): boolean {
  return raw && typeof raw === 'object'
    && typeof raw.schemaVersion === 'number'
    && typeof raw.encrypted === 'boolean';
}

/**
 * Reads either format: a v1 envelope, or a pre-versioning bare settings object.
 *
 * Throws on anything else rather than guessing, so a truncated or unrelated
 * JSON file fails loudly instead of half-importing.
 */
export function parseSettingsExport(raw: any): ParsedSettingsExport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Not a settings file: expected a JSON object.');
  }

  if (!looksLikeEnvelope(raw)) {
    // Pre-versioning export: the file is the settings object itself.
    return {
      schemaVersion: LEGACY_SETTINGS_EXPORT_SCHEMA_VERSION,
      encrypted: false,
      settings: raw as Record<string, any>
    };
  }

  if (raw.schemaVersion > SETTINGS_EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `This settings file was written by a newer version of the app `
      + `(format v${raw.schemaVersion}, this build reads v${SETTINGS_EXPORT_SCHEMA_VERSION}). Update the app and try again.`
    );
  }

  if (raw.encrypted) {
    const envelope = raw as EncryptedSettingsExport;
    if (!envelope.payload || !envelope.kdf?.salt || !envelope.cipher?.iv || !envelope.cipher?.authTag) {
      throw new Error('Encrypted settings file is incomplete or corrupted.');
    }
    return {
      schemaVersion: envelope.schemaVersion,
      encrypted: true,
      envelope,
      exportedAt: envelope.exportedAt,
      appVersion: envelope.appVersion
    };
  }

  const plain = raw as PlainSettingsExport;
  if (!plain.settings || typeof plain.settings !== 'object') {
    throw new Error('Settings file is missing its settings section.');
  }

  return {
    schemaVersion: plain.schemaVersion,
    encrypted: false,
    settings: plain.settings,
    exportedAt: plain.exportedAt,
    appVersion: plain.appVersion
  };
}
