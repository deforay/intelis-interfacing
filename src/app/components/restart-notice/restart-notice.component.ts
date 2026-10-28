import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { ElectronService } from '../../core/services';
import { ConnectionManagerService } from '../../services/connection-manager.service';
import { DatabaseService } from '../../services/database.service';
import { ElectronStoreService } from '../../services/electron-store.service';

/**
 * Counts down and restarts the app when the database needs a restart to
 * finish updating. The app does not work properly until then, so there is no
 * way to put it off, only to restart sooner. An analyzer that is sending when
 * the count ends is given time to finish, so no transmission is cut off.
 */
@Component({
  standalone: false,
  selector: 'app-restart-notice',
  templateUrl: './restart-notice.component.html',
  styleUrls: ['./restart-notice.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager
})
export class RestartNoticeComponent implements OnInit, OnDestroy {
  static readonly COUNTDOWN_SECONDS = 30;
  /** The longest the restart waits for transmissions in progress. */
  static readonly MAX_WAIT_SECONDS = 120;

  public visible = false;
  public secondsLeft = RestartNoticeComponent.COUNTDOWN_SECONDS;
  /** Instruments the restart is waiting for, once the count has ended. */
  public waitingFor: string[] = [];
  /** True while results that arrived are still being saved. */
  public waitingForSaves = false;
  public restarting = false;

  private waitedSeconds = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private subscription: Subscription | null = null;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly connectionManager: ConnectionManagerService,
    private readonly electronService: ElectronService,
    private readonly store: ElectronStoreService,
    private readonly cdRef: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.subscription = this.databaseService.restartRequired$.subscribe(required => {
      if (required && !this.visible) {
        this.start();
      }
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.stopTimer();
  }

  restartNow(): void {
    if (this.restarting) return;
    this.restarting = true;
    this.stopTimer();
    this.cdRef.detectChanges();
    this.databaseService.performForceRerunMigrations().catch(err => {
      console.error('Could not restart to finish updating:', err);
      this.restarting = false;
      this.cdRef.detectChanges();
    });
  }

  private start(): void {
    this.visible = true;
    this.secondsLeft = RestartNoticeComponent.COUNTDOWN_SECONDS;
    this.waitedSeconds = 0;
    this.waitingFor = [];
    this.waitingForSaves = false;
    // The window is often hidden in the tray while instruments run.
    this.electronService.ipcRenderer?.invoke('show-main-window').catch(() => {});
    try {
      this.store.showNotification(
        'Restart required',
        `The Interface Tool restarts in ${RestartNoticeComponent.COUNTDOWN_SECONDS} seconds to finish updating.`
      );
    } catch {
      // A notification is a courtesy. The countdown on screen is the notice.
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.cdRef.detectChanges();
  }

  private tick(): void {
    if (this.secondsLeft > 0) {
      this.secondsLeft--;
    }
    if (this.secondsLeft === 0) {
      this.waitingFor = this.connectionManager.instrumentsReceiving();
      // An instrument stops counting as sending before its results are
      // written, so unsaved data holds the restart too.
      this.waitingForSaves = this.waitingFor.length === 0 && this.connectionManager.hasUnsavedData();
      const busy = this.waitingFor.length > 0 || this.waitingForSaves;
      if (!busy || this.waitedSeconds >= RestartNoticeComponent.MAX_WAIT_SECONDS) {
        this.restartNow();
        return;
      }
      this.waitedSeconds++;
    }
    this.cdRef.detectChanges();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
