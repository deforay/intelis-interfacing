import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { AvailableRelease, resolveInstalledUpdate, resolveUpdateNudge } from '../../../shared/update-check';
import { ElectronService } from '../core/services';
import { ElectronStoreService } from './electron-store.service';

/** How long between asking. A release is not news that needs to arrive quickly. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Long enough after startup that connecting instruments comes first. */
const FIRST_CHECK_DELAY_MS = 30_000;
const DISMISSED_VERSION_KEY = 'dismissedUpdateVersion';
/**
 * How often to look at the version on disk. It is a small local file, and an
 * upgrade done over SSH should be noticed by whoever next looks at the screen.
 */
const INSTALLED_CHECK_INTERVAL_MS = 60_000;

/**
 * Tells the operator when a newer version has been published, and nothing else.
 *
 * WHY the release feed rather than the laboratory's own system: this tool is
 * meant to stand on its own in front of any information system, and a version
 * check routed through one vendor's server would quietly make it that vendor's
 * tool. The releases are public; anyone running this can ask about them without
 * asking anyone's permission, and a laboratory with no LIS connection
 * configured at all is told just the same.
 *
 * WHY not automatic updates: an unattended Windows install would need a signing
 * certificate to be anything but alarming, the portable build cannot be updated
 * in place at all, and on Debian the package is the distribution's to manage. More to the point, a machine sitting between
 * an analyzer and a laboratory information system should not restart itself
 * mid-run because a release happened. So this says there is one, and leaves the
 * decision with the laboratory.
 */
@Injectable({ providedIn: 'root' })
export class UpdateCheckService implements OnDestroy {
  private readonly available = new BehaviorSubject<AvailableRelease | null>(null);
  private readonly installed = new BehaviorSubject<AvailableRelease | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private installedTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly electron: ElectronService,
    private readonly store: ElectronStoreService
  ) {}

  /** What to show, or null when there is nothing worth saying. */
  availableUpdate(): Observable<AvailableRelease | null> {
    return this.available.asObservable();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.schedule(FIRST_CHECK_DELAY_MS);
    this.installedTimer = setInterval(() => void this.checkInstalled(), INSTALLED_CHECK_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.stopInstalledChecks();
  }

  /** A version installed under the running one, or null. */
  installedUpdate(): Observable<AvailableRelease | null> {
    return this.installed.asObservable();
  }

  /**
   * Asks whether the version on disk differs from the one running. Once it
   * does, the checks stop: the answer cannot change back until a restart.
   */
  async checkInstalled(): Promise<void> {
    const runningVersion = this.store.get('appVersion');
    if (!runningVersion || this.installed.value || !this.electron.isElectron || !this.electron.ipcRenderer) {
      return;
    }

    let installedVersion: string | null = null;
    try {
      const result = await this.electron.ipcRenderer.invoke('update-check-installed-version');
      installedVersion = typeof result?.version === 'string' ? result.version : null;
    } catch {
      return;
    }

    const update = resolveInstalledUpdate(runningVersion, installedVersion);
    if (!update) {
      return;
    }
    this.stopInstalledChecks();
    this.installed.next(update);
    try {
      // The window is often hidden in the tray while instruments run.
      this.store.showNotification(
        `Version ${update.version} is installed`,
        'Restart InteLIS Interfacing to finish the update.'
      );
    } catch {
      // A notification is a courtesy. The banner is the notice.
    }
  }

  /** Restarts the app. The caller waits for analyzers that are sending first. */
  async restart(): Promise<void> {
    await this.electron.ipcRenderer?.invoke('update-check-restart');
  }

  private stopInstalledChecks(): void {
    if (this.installedTimer) {
      clearInterval(this.installedTimer);
      this.installedTimer = null;
    }
  }

  /**
   * Stops this version being mentioned again. A later one still will: the
   * version is remembered rather than the fact of dismissing.
   */
  dismiss(version: string): void {
    this.store.set(DISMISSED_VERSION_KEY, version);
    this.available.next(null);
  }

  async openReleasesPage(): Promise<void> {
    if (!this.electron.isElectron || !this.electron.ipcRenderer) {
      return;
    }
    try {
      await this.electron.ipcRenderer.invoke('update-check-open-releases');
    } catch {
      // Nothing to recover: the version is on screen either way.
    }
  }

  /** Asks what the newest published release is, and works out whether to say so. */
  async check(): Promise<void> {
    const currentVersion = this.store.get('appVersion');
    if (!currentVersion) {
      return;
    }

    this.available.next(resolveUpdateNudge({
      currentVersion,
      publishedVersion: await this.fetchPublishedVersion(),
      dismissedVersion: this.store.get(DISMISSED_VERSION_KEY)
    }));
  }

  private async fetchPublishedVersion(): Promise<string | null> {
    if (!this.electron.isElectron || !this.electron.ipcRenderer) {
      return null;
    }
    try {
      const result = await this.electron.ipcRenderer.invoke('update-check-latest-release');
      return typeof result?.version === 'string' ? result.version : null;
    } catch {
      // No route out is the normal state in many laboratories, not a fault.
      return null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule(CHECK_INTERVAL_MS));
    }, delayMs);
  }
}
