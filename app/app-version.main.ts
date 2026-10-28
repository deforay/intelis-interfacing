import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

let cached: string | null = null;

/**
 * This app's version. A packaged app reports it through app.getVersion(), but
 * an unpackaged run (`npm start`, the end-to-end tests) reports Electron's own
 * version there. Screens, the update check, backups and usage statistics all
 * show or send this value, so an unpackaged run reads it from the package.json
 * beside main.js instead.
 */
export function appVersion(): string {
  if (cached) return cached;
  cached = app.getVersion();
  if (!app.isPackaged) {
    try {
      const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
      if (typeof version === 'string' && version) cached = version;
    } catch (error) {
      console.warn('Could not read the app version from package.json:', error);
    }
  }
  return cached;
}

/**
 * The version on disk now, read fresh each time. It differs from appVersion()
 * once a newer package has been installed while this one runs: the package
 * manager swaps the files, and the running app goes on as the old version
 * until it restarts. The build ships without asar, so the package.json beside
 * main.js is the new one as soon as the install finishes.
 *
 * Null for an unpackaged run, where package.json changes with every version
 * bump and a restart prompt would only get in the way.
 */
export function installedVersion(): string | null {
  if (!app.isPackaged) return null;
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return typeof version === 'string' && version ? version : null;
  } catch {
    // Read mid-install, the file can be missing or half written. The next
    // check reads it again.
    return null;
  }
}
