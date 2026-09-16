// Settings export, import and scheduled local backup.
//
// All of this lives in main rather than the renderer because main owns the
// store, and because passphrases and decrypted credentials should not cross
// IPC. The renderer sends "export encrypted, here is the passphrase" and gets
// back a status; it never handles the plaintext payload.

import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log/main';

import {
  MIN_PASSPHRASE_LENGTH,
  decryptSettings,
  encryptSettings
} from './settings-crypto.main';
import {
  DEFAULT_SETTINGS_BACKUP_CONFIG,
  LAST_SETTINGS_BACKUP_AT_KEY,
  LAST_SETTINGS_BACKUP_CHECK_AT_KEY,
  LAST_SETTINGS_BACKUP_FINGERPRINT_KEY,
  PlainSettingsExport,
  SETTINGS_BACKUP_CONFIG_KEY,
  SETTINGS_BACKUP_DIR_NAME,
  SETTINGS_BACKUP_INTERVAL_MS,
  SETTINGS_EXPORT_SCHEMA_VERSION,
  SettingsBackupConfig,
  buildManualExportFileName,
  buildScheduledBackupFileName,
  isScheduledBackupFileName,
  normalizeBackupConfig,
  parseSettingsExport,
  prepareSettingsForExport,
  selectBackupsToPrune,
  settingsFingerprint,
  stripInstallationIdentity
} from '../shared/settings-backup';

export interface SettingsBackupDeps {
  store: any;
  appVersion: string;
  userDataPath: string;
  getWindow: () => BrowserWindow | null;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function buildPlainExport(
  settings: Record<string, any>,
  meta: { appVersion: string; exportedAt: string; source: 'manual' | 'scheduled' }
): PlainSettingsExport {
  return {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
    exportedAt: meta.exportedAt,
    appVersion: meta.appVersion,
    source: meta.source,
    encrypted: false,
    settings
  };
}

function readBackupConfig(store: any): SettingsBackupConfig {
  return normalizeBackupConfig(store.get(SETTINGS_BACKUP_CONFIG_KEY) ?? DEFAULT_SETTINGS_BACKUP_CONFIG);
}

function backupDir(userDataPath: string): string {
  return path.join(userDataPath, SETTINGS_BACKUP_DIR_NAME);
}

export interface BackupWriteResult {
  /** False when the configuration was identical to the last backup. */
  written: boolean;
  filePath?: string;
  pruned: number;
}

/**
 * Writes one scrubbed, versioned snapshot and prunes older ones — unless the
 * configuration is byte-for-byte what the last backup already holds.
 *
 * Skipping unchanged snapshots is what makes retention useful here. This
 * configuration changes a few times a year, so writing on every schedule would
 * fill all ten slots with copies of today and prune away the only older
 * configuration worth going back to.
 *
 * Scheduled backups never contain credentials: they are written unattended, so
 * a passphrase would have to be stored on the same disk as the backups, which
 * protects nothing. Credentials are a deliberate manual export.
 */
function writeScheduledBackup(deps: SettingsBackupDeps): BackupWriteResult {
  const now = new Date();
  const settings = prepareSettingsForExport(deps.store.store, { includeCredentials: false });
  const fingerprint = settingsFingerprint(settings);

  deps.store.set(LAST_SETTINGS_BACKUP_CHECK_AT_KEY, now.toISOString());

  const dir = backupDir(deps.userDataPath);
  // A matching fingerprint is only trustworthy while the file it describes is
  // still on disk; if the folder was emptied by hand, write a fresh one.
  const unchanged = deps.store.get(LAST_SETTINGS_BACKUP_FINGERPRINT_KEY) === fingerprint
    && existingBackupCount(dir) > 0;

  if (unchanged) {
    return { written: false, pruned: 0 };
  }

  fs.mkdirSync(dir, { recursive: true });

  const envelope = buildPlainExport(settings, {
    appVersion: deps.appVersion,
    exportedAt: now.toISOString(),
    source: 'scheduled'
  });

  const filePath = uniqueBackupPath(dir, buildScheduledBackupFileName(now));
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');

  const { retention } = readBackupConfig(deps.store);
  const stale = selectBackupsToPrune(fs.readdirSync(dir), retention, now);
  stale.forEach(name => {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (err) {
      log.warn(`Could not prune old settings backup ${name}: ${formatUnknownError(err)}`);
    }
  });

  deps.store.set(LAST_SETTINGS_BACKUP_AT_KEY, now.toISOString());
  deps.store.set(LAST_SETTINGS_BACKUP_FINGERPRINT_KEY, fingerprint);
  return { written: true, filePath, pruned: stale.length };
}

/**
 * Backup names carry a timestamp only to the second, so two backups written
 * within the same second would resolve to one path and the second would
 * silently replace the first — destroying a configuration that differed.
 * Rare, but the whole point of this folder is that nothing in it is lost.
 *
 * The suffix keeps the name sorting immediately after the colliding one, so
 * chronological pruning still holds.
 */
function uniqueBackupPath(dir: string, fileName: string): string {
  const candidate = path.join(dir, fileName);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  const base = fileName.replace(/\.json$/, '');
  for (let suffix = 2; suffix < 1000; suffix++) {
    const next = path.join(dir, `${base}-${suffix}.json`);
    if (!fs.existsSync(next)) {
      return next;
    }
  }
  throw new Error(`Could not find a free backup filename for ${fileName}`);
}

function existingBackupCount(dir: string): number {
  try {
    return fs.readdirSync(dir).filter(isScheduledBackupFileName).length;
  } catch {
    // Directory does not exist until the first backup runs.
    return 0;
  }
}

let backupTimer: NodeJS.Timeout | null = null;

// Checked far more often than the backup interval so that a machine which was
// asleep or shut down at the scheduled moment still backs up shortly after it
// wakes, instead of skipping to the next full interval.
const SCHEDULER_TICK_MS = 5 * 60 * 1000;

function backupIsDue(store: any, config: SettingsBackupConfig, now: number): boolean {
  // Keyed on when a backup was last *considered*, not last written. An
  // unchanged configuration writes nothing, and keying on the write time would
  // leave it permanently due and re-fingerprinting on every tick.
  const last = store.get(LAST_SETTINGS_BACKUP_CHECK_AT_KEY);
  if (!last) {
    return true;
  }
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) {
    return true;
  }
  // A clock moved backwards would otherwise park the next backup arbitrarily
  // far in the future, so treat a future timestamp as due.
  if (lastMs > now) {
    return true;
  }
  return now - lastMs >= SETTINGS_BACKUP_INTERVAL_MS[config.interval];
}

function runScheduledBackupIfDue(deps: SettingsBackupDeps): void {
  try {
    const config = readBackupConfig(deps.store);
    if (!config.enabled || !backupIsDue(deps.store, config, Date.now())) {
      return;
    }
    const result = writeScheduledBackup(deps);
    console.log(result.written
      ? `Settings backup written: ${result.filePath}${result.pruned ? ` (pruned ${result.pruned})` : ''}`
      : 'Settings unchanged since the last backup; nothing written.');
  } catch (err) {
    // A failed backup must never take down the app or interrupt instrument
    // traffic; it is reported and retried on the next tick.
    log.error(`Scheduled settings backup failed: ${formatUnknownError(err)}`);
  }
}

export function startScheduledSettingsBackups(deps: SettingsBackupDeps): void {
  stopScheduledSettingsBackups();
  runScheduledBackupIfDue(deps);
  backupTimer = setInterval(() => runScheduledBackupIfDue(deps), SCHEDULER_TICK_MS);
  // Do not hold the event loop open on quit purely for the backup timer.
  backupTimer.unref?.();
}

export function stopScheduledSettingsBackups(): void {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
}

export function registerSettingsBackupIpc(deps: SettingsBackupDeps): void {
  // The last file the operator picked in the import dialog. See import-settings.
  let chosenImportPath: string | null = null;

  /**
   * Manual export. `includeCredentials` requires a passphrase: credentials are
   * only ever written to disk inside an encrypted envelope.
   */
  ipcMain.handle('export-settings', async (_event, options?: { includeCredentials?: boolean; passphrase?: string }) => {
    try {
      const includeCredentials = options?.includeCredentials === true;
      const passphrase = options?.passphrase ?? '';

      if (includeCredentials && passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return {
          status: 'error',
          message: `A passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters is required to export credentials.`
        };
      }

      const now = new Date();
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: includeCredentials ? 'Export Settings and Credentials' : 'Export Settings',
        defaultPath: buildManualExportFileName(now, includeCredentials),
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      });

      if (canceled || !filePath) {
        return { status: 'cancelled', message: 'Export cancelled.' };
      }

      const settings = prepareSettingsForExport(deps.store.store, { includeCredentials });
      const meta = { appVersion: deps.appVersion, exportedAt: now.toISOString(), source: 'manual' as const };
      const envelope = includeCredentials
        ? encryptSettings(settings, passphrase, meta)
        : buildPlainExport(settings, meta);

      fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');

      return {
        status: 'success',
        message: includeCredentials
          ? 'Settings and credentials exported. Keep the passphrase safe — the file cannot be restored without it.'
          : 'Settings successfully exported. Credentials were not included.'
      };
    } catch (err) {
      log.error(`Failed to save settings: ${formatUnknownError(err)}`);
      return { status: 'error', message: 'Failed to export settings.' };
    }
  });

  /**
   * Inspects a chosen file without importing it, so the renderer can tell the
   * user what they picked and prompt for a passphrase only when one is needed.
   */
  ipcMain.handle('inspect-settings-file', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Import Settings',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile']
    });

    if (canceled || !filePaths?.length) {
      return { status: 'cancelled', message: 'Import cancelled.' };
    }

    try {
      const parsed = parseSettingsExport(JSON.parse(fs.readFileSync(filePaths[0], 'utf-8')));
      chosenImportPath = filePaths[0];
      return {
        status: 'success',
        filePath: filePaths[0],
        encrypted: parsed.encrypted,
        schemaVersion: parsed.schemaVersion,
        exportedAt: parsed.exportedAt ?? null,
        appVersion: parsed.appVersion ?? null
      };
    } catch (err) {
      return { status: 'error', message: formatUnknownError(err) };
    }
  });

  ipcMain.handle('import-settings', async (_event, options?: { filePath?: string; passphrase?: string }) => {
    try {
      let filePath = options?.filePath;

      // The path comes back from the renderer only so a passphrase can be
      // retried without picking the file again. It is accepted only if it is
      // the file the operator chose in the dialog here, so this handler can
      // never be pointed at an arbitrary path.
      if (filePath && filePath !== chosenImportPath) {
        return { status: 'error', message: 'Choose the settings file again with Import Settings.' };
      }

      // No path means the caller has not been through inspect yet (or is older
      // code); ask for the file here so import still works on its own.
      if (!filePath) {
        const { filePaths, canceled } = await dialog.showOpenDialog({
          title: 'Import Settings',
          filters: [{ name: 'JSON Files', extensions: ['json'] }],
          properties: ['openFile']
        });
        if (canceled || !filePaths?.length) {
          return { status: 'cancelled', message: 'Import cancelled.' };
        }
        filePath = filePaths[0];
        chosenImportPath = filePath;
      }

      const parsed = parseSettingsExport(JSON.parse(fs.readFileSync(filePath, 'utf-8')));

      let importedSettings: Record<string, any>;
      if (parsed.encrypted) {
        if (!options?.passphrase) {
          return { status: 'passphrase-required', message: 'This file is encrypted. Enter its passphrase to import it.' };
        }
        try {
          importedSettings = decryptSettings(parsed.envelope, options.passphrase);
        } catch {
          // Any failure here is indistinguishable from a wrong passphrase, and
          // saying more would only help someone guessing.
          return { status: 'error', message: 'Could not decrypt the file. Check the passphrase and try again.' };
        }
      } else {
        importedSettings = parsed.settings;
      }

      // Applied on the way in as well as the way out: a hand-edited file must
      // not be able to plant another installation's identity.
      stripInstallationIdentity(importedSettings);

      Object.keys(importedSettings).forEach(key => {
        deps.store.set(key, importedSettings[key]);
      });
      chosenImportPath = null;

      deps.getWindow()?.webContents.send('imported-settings', importedSettings);

      return {
        status: 'success',
        message: parsed.encrypted
          ? 'Settings and credentials successfully imported.'
          : 'Settings successfully imported. Credentials were not in this file and must be re-entered.'
      };
    } catch (err) {
      log.error(`Failed to import settings: ${formatUnknownError(err)}`);
      return { status: 'error', message: `Failed to import settings. ${formatUnknownError(err)}` };
    }
  });

  ipcMain.handle('get-backup-config', () => {
    const dir = backupDir(deps.userDataPath);
    return {
      config: readBackupConfig(deps.store),
      directory: dir,
      lastBackupAt: deps.store.get(LAST_SETTINGS_BACKUP_AT_KEY) ?? null,
      lastCheckedAt: deps.store.get(LAST_SETTINGS_BACKUP_CHECK_AT_KEY) ?? null,
      backupCount: existingBackupCount(dir)
    };
  });

  ipcMain.handle('set-backup-config', (_event, raw: Partial<SettingsBackupConfig>) => {
    const config = normalizeBackupConfig({ ...readBackupConfig(deps.store), ...raw });
    deps.store.set(SETTINGS_BACKUP_CONFIG_KEY, config);
    // Restart so an interval change takes effect now rather than after the
    // previously scheduled tick.
    startScheduledSettingsBackups(deps);
    return { status: 'success', config };
  });

  ipcMain.handle('run-backup-now', () => {
    try {
      const result = writeScheduledBackup(deps);
      // Reported rather than written twice: a second identical file would tell
      // the user nothing and would push a genuinely older one out of retention.
      return result.written
        ? { status: 'success', written: true, filePath: result.filePath, pruned: result.pruned, message: 'Backup written.' }
        : { status: 'success', written: false, message: 'Settings are unchanged since the last backup.' };
    } catch (err) {
      log.error(`Manual backup run failed: ${formatUnknownError(err)}`);
      return { status: 'error', message: 'Could not write the backup.' };
    }
  });

  ipcMain.handle('open-backup-folder', async () => {
    const dir = backupDir(deps.userDataPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const error = await shell.openPath(dir);
      return error ? { status: 'error', message: error } : { status: 'success' };
    } catch (err) {
      return { status: 'error', message: formatUnknownError(err) };
    }
  });
}
