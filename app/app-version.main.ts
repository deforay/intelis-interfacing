import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

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
