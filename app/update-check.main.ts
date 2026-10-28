/**
 * Asks, once in a while, whether a newer version has been published.
 *
 * WHY the main process: outbound requests belong here, with the rest of them,
 * and Electron's net stack follows the machine's proxy configuration. A
 * laboratory that reaches the internet through a proxy is common; one that has
 * taught a renderer's fetch about it is not.
 *
 * This asks and reports. It does not download anything, does not run anything,
 * and cannot be told which page to open: the releases page is a constant here,
 * so a renderer can ask for it to be opened but not choose what "it" is.
 */
import { app, ipcMain, net, shell } from 'electron';
import { RELEASES_API_URL, RELEASES_URL } from '../shared/update-check';
import { installedVersion } from './app-version.main';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

interface ReleaseLookup {
  version: string | null;
}

async function readLatestReleaseVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await net.fetch(RELEASES_API_URL, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        'Cache-Control': 'no-store',
        // GitHub asks for one, and refuses requests that do not send one.
        'User-Agent': 'intelis-interfacing'
      }
    });
    if (!response.ok) {
      return null;
    }

    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body).toString('utf8'));
    const tag = payload?.tag_name;
    return typeof tag === 'string' && tag ? tag : null;
  } catch {
    // A laboratory with no route to the internet is the normal case, not a
    // fault, so this stays quiet. Nothing here is load-bearing: no answer
    // means no banner.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function registerUpdateCheckIpc(): void {
  ipcMain.handle('update-check-latest-release', async (): Promise<ReleaseLookup> => ({
    version: await readLatestReleaseVersion()
  }));

  // Takes no argument on purpose. The renderer can ask for the releases page
  // to be opened; it cannot nominate a different page.
  ipcMain.handle('update-check-open-releases', async (): Promise<void> => {
    await shell.openExternal(RELEASES_URL);
  });

  ipcMain.handle('update-check-installed-version', (): ReleaseLookup => ({
    version: installedVersion()
  }));

  // The operator asks for this restart, and the renderer waits for analyzers
  // that are sending before it does. Nothing here restarts on its own.
  ipcMain.handle('update-check-restart', (): void => {
    setTimeout(() => {
      app.relaunch();
      app.exit();
    }, 300);
  });
}
