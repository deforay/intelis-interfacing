import { Component, ChangeDetectionStrategy } from '@angular/core';
import { ElectronService } from './core/services';
import { TranslateService } from '@ngx-translate/core';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './services/database.service';
import { IntelisResultSyncService } from './services/intelis-result-sync.service';
import { IntelisUsageSyncService } from './services/intelis-usage-sync.service';
import { ResultWebhookSyncService } from './services/result-webhook-sync.service';

@Component({
  standalone: false,
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  private sessionId: string | null = null;

  constructor(
    private electronService: ElectronService,
    private translate: TranslateService,
    private databaseService: DatabaseService,
    private intelisResultSync: IntelisResultSyncService,
    private intelisUsageSync: IntelisUsageSyncService,
    private resultWebhookSync: ResultWebhookSyncService
  ) {
    this.translate.setFallbackLang('en');

    if (electronService.isElectron) {
      this.initializeSession();
      void this.databaseService.recordTelemetryEvent({
        eventType: 'application.started',
        category: 'usage',
        outcome: 'started'
      });
      this.intelisResultSync.start();
      this.intelisUsageSync.start();
      this.resultWebhookSync.start();
      console.log(process.env);
      console.log('Run in electron');
      console.log('Electron ipcRenderer', this.electronService.ipcRenderer);
      console.log('NodeJS childProcess', this.electronService.childProcess);
    } else {
      console.log('Run in browser');
    }


    window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
  }

  initializeSession(): void {
    const storedSessionId = localStorage.getItem('sessionId');

    if (storedSessionId) {
      this.sessionId = storedSessionId;
    } else {
      this.sessionId = uuidv4();
      localStorage.setItem('sessionId', this.sessionId);
    }

    const startTime = this.getFormattedDateTime();
    localStorage.setItem(`${this.sessionId}_startTime`, startTime);
  }

  getFormattedDateTime(): string {
    const now = new Date();
    const year = String(now.getFullYear()).padStart(4, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  handleBeforeUnload(event: Event): void {
    if (this.sessionId) {
      const closeTime = this.getFormattedDateTime();
      localStorage.setItem(`${this.sessionId}_closeTime`, closeTime);
    }
  }
}
