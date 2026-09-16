import { Component, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { FormBuilder, FormGroup, FormArray, Validators, AbstractControl, ValidatorFn } from '@angular/forms';
import { Router } from '@angular/router';
import { ElectronService } from '../../core/services';
import { ElectronStoreService } from '../../services/electron-store.service';
import { UtilitiesService } from '../../services/utilities.service';
import { CryptoService } from '../../services/crypto.service';
import { v4 as uuidv4 } from 'uuid';
import { ConnectionManagerService } from '../../services/connection-manager.service';
import { Subscription } from 'rxjs';
import { DatabaseService } from '../../services/database.service';
import { LisApiService } from '../../services/lis-api.service';
import { LisApiConfig } from '../../interfaces/lis-api-config.interface';
import { IntelisConnectionService } from '../../services/intelis-connection.service';
import { ResultWebhookService } from '../../services/result-webhook.service';
import { ResultWebhookSyncService } from '../../services/result-webhook-sync.service';
import {
  isPlainHttpToAnotherHost,
  ResultWebhookSaveRequest,
  ResultWebhookState
} from '../../../../shared/result-webhook';
import {
  formatIntelisConnectionCode,
  getIntelisResultDeliveryLimits,
  IntelisConnectionState,
  isValidIntelisConnectionCode
} from '../../../../shared/intelis-connection';
import {
  DEFAULT_SETTINGS_BACKUP_CONFIG,
  MIN_PASSPHRASE_LENGTH,
  SettingsBackupConfig,
  SettingsBackupInterval
} from '../../../../shared/settings-backup';

@Component({
  standalone: false,
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./settings.component.scss']
})
export class SettingsComponent implements OnInit, OnDestroy {
  public settingsForm: FormGroup;
  public appPath: string = "";
  public appVersion: string = null;
  public machineIps: string[] = [];
  public availableInstruments = [];
  private instrumentsSubscription: Subscription;
  private lisSubscription: Subscription;
  private intelisSubscription: Subscription;

  // Sidebar
  public activeSection: string = 'system';
  public sidebarCollapsed: boolean = true;
  public readonly sections = [
    { id: 'system', label: 'System', icon: 'fas fa-cog' },
    { id: 'database', label: 'Database', icon: 'fas fa-database' },
    { id: 'instruments', label: 'Instruments', icon: 'fas fa-microscope' },
    { id: 'lisapi', label: 'LIS Connection', icon: 'fas fa-plug' },
    { id: 'forwarding', label: 'Result Forwarding', icon: 'fas fa-share-square' },
    { id: 'backup', label: 'Backup & Restore', icon: 'fas fa-shield-alt' },
    { id: 'troubleshoot', label: 'Troubleshooting', icon: 'fas fa-wrench' }
  ];

  // LIS API
  public lisInstrumentNames: string[] = [];
  public lisApiFetchStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle';
  public lisApiFetchError: string = '';
  public intelisConnectionState: IntelisConnectionState = { configured: false };
  public intelisBusy: boolean = false;
  public intelisError: string = '';
  public lisConnectionChoice: 'intelis' | 'other' | null = null;
  public logCleanupBusy: boolean = false;
  public logCleanupMessage: string = '';

  // Result forwarding. Its own form: it saves on its own button, without the
  // instrument reconnect the main settings save performs.
  public resultWebhookForm: FormGroup;
  public resultWebhookState: ResultWebhookState = {
    configured: false, enabled: false, url: '', authType: 'none', username: '', hasSecret: false
  };
  public resultWebhookPending: number | null = null;
  public resultWebhookBusy: boolean = false;
  public resultWebhookError: string = '';
  public resultWebhookMessage: string = '';

  // Backup & restore
  public backupConfig: SettingsBackupConfig = { ...DEFAULT_SETTINGS_BACKUP_CONFIG };
  public backupDirectory: string = '';
  public lastBackupAt: string = null;
  public backupCount: number = 0;
  public backupBusy: boolean = false;
  public backupMessage: string = '';
  public lastCheckedAt: string = null;
  public readonly backupIntervals: { value: SettingsBackupInterval; label: string }[] = [
    { value: 'daily', label: 'Check daily' },
    { value: 'weekly', label: 'Check weekly' },
    { value: 'monthly', label: 'Check monthly' }
  ];

  /**
   * Passphrase entry for encrypted export/import. Native dialogs cannot take
   * text input, so this drives a small in-app modal. The passphrase is held
   * only for the length of the operation and cleared afterwards.
   */
  public passphrasePrompt: {
    mode: 'export' | 'import';
    passphrase: string;
    confirmPassphrase: string;
    error: string;
    filePath?: string;
  } = null;

  public readonly minPassphraseLength = MIN_PASSPHRASE_LENGTH;

  get intelisResultsEnabled(): boolean {
    return !!getIntelisResultDeliveryLimits(this.intelisConnectionState.connection);
  }

  scopeLabel(scope: string): string {
    const labels: Record<string, string> = {
      'connection:read': 'Read connection details',
      'results:write': 'Send results',
      'telemetry:write': 'Send usage statistics'
    };
    return labels[scope] || scope.replace(/[:_-]+/g, ' ');
  }

  get sectionSetupStatus(): Record<string, boolean> {
    const common = this.settingsForm?.get('commonSettings');
    const instruments = this.instrumentsSettings;
    return {
      system: !!(common?.get('labID')?.value && common?.get('labName')?.value),
      database: !!(common?.get('mysqlHost')?.value),
      instruments: instruments?.length > 0,
      lisapi: this.intelisConnectionState.configured || !!this.settingsForm?.get('lisApiSettings.url')?.value
    };
  }

  constructor(
    private readonly formBuilder: FormBuilder,
    private readonly electronService: ElectronService,
    private readonly router: Router,
    private readonly electronStoreService: ElectronStoreService,
    private readonly utilitiesService: UtilitiesService,
    private readonly cryptoService: CryptoService,
    private connectionManagerService: ConnectionManagerService,
    private readonly databaseService: DatabaseService,
    private readonly lisApiService: LisApiService,
    private readonly intelisConnectionService: IntelisConnectionService,
    private readonly resultWebhookService: ResultWebhookService,
    private readonly resultWebhookSync: ResultWebhookSyncService
  ) {

    const commonSettingsStore = this.electronStoreService.get('commonConfig');
    const instrumentSettingsStore = (this.electronStoreService.get('instrumentsConfig') || [])
      .sort((a, b) => (parseInt(a.displayorder, 10) || Number.MAX_SAFE_INTEGER) - (parseInt(b.displayorder, 10) || Number.MAX_SAFE_INTEGER));
    const lisApiConfigStore = this.electronStoreService.get('lisApiConfig');
    this.appPath = this.electronStoreService.get('appPath');
    this.appVersion = this.electronStoreService.get('appVersion');
    this.machineIps = this.getMachineIps();

    // Initialize the form with the existing settings
    this.settingsForm = this.formBuilder.group({
      commonSettings: this.formBuilder.group({
        labID: ['', Validators.required],
        labName: ['', Validators.required],
        mysqlHost: [''],
        mysqlPort: ['', [
          Validators.pattern('^[0-9]+$'),
          (control) => {
            const value = control.value;
            if (!value) return null; // Allow empty value since MySQL is optional
            const portNum = parseInt(value);
            return (isNaN(portNum) || portNum < 1 || portNum > 65535) ? { pattern: true } : null;
          }
        ]],
        mysqlDb: [''],
        mysqlUser: [''],
        mysqlPassword: [''],
        interfaceAutoConnect: ['yes', Validators.required]
      }),
      lisApiSettings: this.formBuilder.group({
        url: [''],
        authType: ['none'],
        credentials: this.formBuilder.group({
          token: [''],
          username: [''],
          password: [''],
          apiKey: ['']
        }),
        fetchInstruments: this.formBuilder.group({
          enabled: [false],
          endpoint: ['/api/instruments']
        })
      }),
      intelisConnection: this.formBuilder.group({
        baseUrl: [''],
        connectionCode: [''],
        displayName: ['']
      }),
      instrumentsSettings: this.formBuilder.array(
        instrumentSettingsStore.map(instrument => this.formBuilder.group(instrument))
      )
    }, { validators: [this.uniqueInstrumentNameValidator(), this.uniqueIpPortValidator()] });

    this.resultWebhookForm = this.formBuilder.group({
      enabled: [false],
      url: [''],
      authType: ['none'],
      username: [''],
      secret: ['']
    });

    this.settingsForm.patchValue({
      commonSettings: commonSettingsStore
    });

    // Load saved LIS API config with decrypted credentials
    if (lisApiConfigStore) {
      const decryptedConfig = { ...lisApiConfigStore };
      if (decryptedConfig.credentials) {
        decryptedConfig.credentials = {
          token: this.cryptoService.decrypt(decryptedConfig.credentials.token || ''),
          username: this.cryptoService.decrypt(decryptedConfig.credentials.username || ''),
          password: this.cryptoService.decrypt(decryptedConfig.credentials.password || ''),
          apiKey: this.cryptoService.decrypt(decryptedConfig.credentials.apiKey || '')
        };
      }
      this.settingsForm.patchValue({ lisApiSettings: decryptedConfig });
      if (decryptedConfig.url) {
        this.lisConnectionChoice = 'other';
      }
    }

  }


  ngOnInit(): void {
    // Subscribe to instrument status
    this.instrumentsSubscription = this.connectionManagerService.getActiveInstruments()
      .subscribe(instruments => {
        this.availableInstruments = instruments;
      });

    // Subscribe to LIS instrument names
    this.lisSubscription = this.lisApiService.getInstrumentNames()
      .subscribe(names => {
        this.lisInstrumentNames = names;
      });

    this.intelisSubscription = this.intelisConnectionService.stateChanges()
      .subscribe(state => {
        this.intelisConnectionState = state;
        // An established managed connection is the clearest source of truth when
        // an older installation also retains an unused custom API configuration.
        if (state.configured) this.lisConnectionChoice = 'intelis';
        this.syncIntelisForm(state);
      });
    void this.intelisConnectionService.load().then(result => {
      if (!result.ok) this.intelisError = result.error?.message || 'Unable to load the InteLIS connection.';
    });
    void this.loadBackupStatus();
    void this.loadResultWebhook();
  }

  ngOnDestroy(): void {
    if (this.instrumentsSubscription) {
      this.instrumentsSubscription.unsubscribe();
    }
    if (this.lisSubscription) {
      this.lisSubscription.unsubscribe();
    }
    if (this.intelisSubscription) {
      this.intelisSubscription.unsubscribe();
    }
  }

  async connectToIntelis(): Promise<void> {
    const form = this.settingsForm.get('intelisConnection');
    const request = {
      baseUrl: (form.get('baseUrl').value || '').trim(),
      connectionCode: (form.get('connectionCode').value || '').trim(),
      displayName: (form.get('displayName').value || '').trim()
    };

    this.intelisBusy = true;
    this.intelisError = '';
    try {
      const result = await this.intelisConnectionService.connect(request);
      form.get('connectionCode').setValue('');
      if (!result.ok) {
        this.intelisError = result.error?.message || 'Unable to connect to InteLIS.';
        return;
      }
      if (result.data?.connection?.facility) {
        this.applyConnectedFacility(result.data);
      }
      if (result.data?.lastError) {
        this.intelisError = result.data.lastError.message;
      }
    } finally {
      this.intelisBusy = false;
    }
  }

  async refreshIntelisConnection(): Promise<void> {
    this.intelisBusy = true;
    this.intelisError = '';
    try {
      const result = await this.intelisConnectionService.refresh();
      if (result.data?.connection?.facility) {
        this.applyConnectedFacility(result.data);
      }
      if (!result.ok) {
        this.intelisError = result.error?.message || 'Unable to refresh the InteLIS connection.';
      }
    } finally {
      this.intelisBusy = false;
    }
  }

  async forgetIntelisConnection(): Promise<void> {
    const result = await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
      type: 'warning',
      buttons: ['Cancel', 'Forget Connection'],
      defaultId: 0,
      title: 'Forget InteLIS Connection',
      message: 'Forget the InteLIS connection on this computer?',
      detail: 'This does not revoke the installation in InteLIS. You will need a Reconnect Code from the facility page to connect this computer again.'
    });
    if (result.response !== 1) return;

    const forgotten = await this.intelisConnectionService.forget();
    if (!forgotten.ok) {
      this.intelisError = forgotten.error?.message || 'Unable to forget the InteLIS connection.';
      return;
    }
    this.intelisError = '';
    this.settingsForm.get('intelisConnection.connectionCode').setValue('');
  }

  get resultWebhookPlainHttp(): boolean {
    return isPlainHttpToAnotherHost((this.resultWebhookForm.get('url').value || '').trim());
  }

  /** A blank secret keeps the saved one only for the same authentication type; the main process enforces this too. */
  get resultWebhookSecretSaved(): boolean {
    return this.resultWebhookState.hasSecret
      && this.resultWebhookState.authType === this.resultWebhookForm.get('authType').value;
  }

  get resultWebhookSecretLabel(): string {
    switch (this.resultWebhookForm.get('authType').value) {
      case 'bearer': return 'Bearer token';
      case 'basic': return 'Password';
      default: return 'API key';
    }
  }

  async loadResultWebhook(): Promise<void> {
    const result = await this.resultWebhookService.load();
    if (!result.ok) {
      this.resultWebhookError = result.error?.message || 'Unable to load result forwarding settings.';
      return;
    }
    this.applyResultWebhookState(result.data);
    await this.refreshResultWebhookPending();
  }

  async testResultWebhook(): Promise<void> {
    this.resultWebhookBusy = true;
    this.resultWebhookError = '';
    this.resultWebhookMessage = '';
    try {
      const result = await this.resultWebhookService.test(this.resultWebhookRequest());
      if (result.ok) {
        this.resultWebhookMessage = `The receiver accepted a test request (HTTP ${result.data?.httpStatus}). No results were sent.`;
      } else {
        this.resultWebhookError = result.error?.message || 'The test request failed.';
      }
    } finally {
      this.resultWebhookBusy = false;
    }
  }

  async saveResultWebhook(): Promise<void> {
    const request = this.resultWebhookRequest();
    this.resultWebhookBusy = true;
    this.resultWebhookError = '';
    this.resultWebhookMessage = '';
    try {
      // The main process decides whether this is the first save, and marks the
      // results already stored, from its own record rather than this form's.
      const result = await this.resultWebhookService.save(request);
      if (!result.ok) {
        this.resultWebhookError = result.error?.message || 'Unable to save result forwarding settings.';
        return;
      }
      this.applyResultWebhookState(result.data);
      this.resultWebhookMessage = result.data.enabled
        ? 'Saved. New results will be forwarded to this receiver.'
        : 'Saved. Forwarding is off; new results are kept and sent once it is turned back on.';
      this.resultWebhookSync.wake();
      await this.refreshResultWebhookPending();
    } catch (error) {
      this.resultWebhookError = `Unable to save result forwarding settings: ${error?.message ?? error}`;
    } finally {
      this.resultWebhookBusy = false;
    }
  }

  private resultWebhookRequest(): ResultWebhookSaveRequest {
    const value = this.resultWebhookForm.value;
    return {
      enabled: value.enabled === true,
      url: (value.url || '').trim(),
      authType: value.authType,
      username: (value.username || '').trim(),
      secret: value.secret || undefined
    };
  }

  private applyResultWebhookState(state: ResultWebhookState): void {
    this.resultWebhookState = state;
    this.resultWebhookForm.reset({
      enabled: state.enabled,
      url: state.url,
      authType: state.authType,
      username: state.username,
      secret: ''
    });
  }

  private async refreshResultWebhookPending(): Promise<void> {
    if (!this.resultWebhookState.activatedAt) {
      // Until the first save, the queue is this installation's whole history,
      // none of which will be sent.
      this.resultWebhookPending = null;
      return;
    }
    try {
      this.resultWebhookPending = await this.databaseService.countPendingResultWebhookResults();
    } catch {
      this.resultWebhookPending = null;
    }
  }

  get intelisMachineCount(): number {
    return (this.intelisConnectionState.connection?.instruments || [])
      .reduce((count, instrument) => count + (instrument.machines?.length || 0), 0);
  }

  get intelisConnectionCodeValid(): boolean {
    return isValidIntelisConnectionCode(
      this.settingsForm.get('intelisConnection.connectionCode')?.value || ''
    );
  }

  formatConnectionCode(event: Event): void {
    const input = event.target as HTMLInputElement;
    const formatted = formatIntelisConnectionCode(input.value);
    input.value = formatted;
    this.settingsForm.get('intelisConnection.connectionCode')?.setValue(formatted, { emitEvent: false });
  }

  private syncIntelisForm(state: IntelisConnectionState): void {
    if (!state.configured) return;
    this.settingsForm.get('intelisConnection').patchValue({
      baseUrl: state.baseUrl || '',
      displayName: state.installation?.displayName || ''
    }, { emitEvent: false });
  }

  private applyConnectedFacility(state: IntelisConnectionState): void {
    const facility = state.connection?.facility;
    if (!facility) return;

    const labID = facility.code || String(facility.id);
    this.settingsForm.get('commonSettings').patchValue({ labID, labName: facility.name });

    // The authenticated InteLIS profile is authoritative. Persist these two
    // neutral lab fields immediately so runtime connections use the correct lab
    // even if the operator leaves Settings without submitting unrelated changes.
    const current = this.electronStoreService.get('commonConfig') || {};
    this.electronStoreService.set('commonConfig', { ...current, labID, labName: facility.name });
  }

  setActiveSection(sectionId: string): void {
    this.activeSection = sectionId;
    this.sidebarCollapsed = true;
  }

  selectLisConnection(choice: 'intelis' | 'other'): void {
    this.lisConnectionChoice = choice;
  }

  showLisConnectionChoices(): void {
    this.lisConnectionChoice = null;
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
  }

  testLisApi(): void {
    this.lisApiFetchStatus = 'loading';
    this.lisApiFetchError = '';
    const config = this.settingsForm.get('lisApiSettings').value as LisApiConfig;
    this.lisApiService.testAndFetch(config).subscribe({
      next: (names) => {
        this.lisInstrumentNames = names;
        this.lisApiFetchStatus = 'success';
      },
      error: (err) => {
        this.lisApiFetchError = err.message || 'Failed to fetch instruments';
        this.lisApiFetchStatus = 'error';
      }
    });
  }

  filterInstrumentNames(value: string): string[] {
    if (!this.lisInstrumentNames.length) {
      return [];
    }
    const usedNames = new Set(
      this.instrumentsSettings.value
        .map(instrument => instrument.analyzerMachineName)
        .filter(name => name && name !== value)
    );
    const available = this.lisInstrumentNames.filter(name => !usedNames.has(name));
    if (!value) {
      return available;
    }
    const filterValue = value.toLowerCase();
    return available.filter(name =>
      name.toLowerCase().includes(filterValue)
    );
  }

  uniqueInstrumentNameValidator(): ValidatorFn {
    return (control: AbstractControl): { [key: string]: any } | null => {
      const instrumentsSettings = control.get('instrumentsSettings') as FormArray;
      const duplicateIndexes = this.findDuplicates(
        instrumentsSettings.value.map(instrument => instrument.analyzerMachineName)
      );
      duplicateIndexes.forEach(index => {
        instrumentsSettings.at(index).get('analyzerMachineName').setErrors({ 'duplicateInstrumentName': true });
      });
      return null;
    };
  }

  uniqueIpPortValidator(): ValidatorFn {
    return (control: AbstractControl): { [key: string]: any } | null => {
      const instrumentsSettings = control.get('instrumentsSettings') as FormArray;
      const duplicateIndexes = this.findDuplicates(
        instrumentsSettings.value.map(instrument => `${instrument.analyzerMachineHost}:${instrument.analyzerMachinePort}`)
      );
      duplicateIndexes.forEach(index => {
        instrumentsSettings.at(index).setErrors({ 'duplicateIpPort': true });
      });
      return null;
    };
  }

  findDuplicates(arr: string[]): number[] {
    const duplicates = [];
    const itemCounts = arr.reduce((acc, item, index) => {
      acc[item] = acc[item] ? [...acc[item], index] : [index];
      return acc;
    }, {});
    for (let key in itemCounts) {
      if (itemCounts[key].length > 1) {
        duplicates.push(...itemCounts[key]);
      }
    }
    return duplicates;
  }

  onConnectionModeChange(index: number, event: Event): void {
    const selectElement = event.target as HTMLSelectElement;
    const connectionMode = selectElement.value;
    if (connectionMode === 'tcpserver') {
      this.instrumentsSettings.at(index).get('analyzerMachineHost').setValue(this.machineIps[0]);
    }
  }

  // Getter for easy access to the instrumentsSettings FormArray
  get instrumentsSettings(): FormArray {
    return this.settingsForm.get('instrumentsSettings') as FormArray;
  }



  public async forceRerunMigrations(): Promise<void> {
    try {
      const result = await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
        type: 'warning',
        buttons: ['Cancel', 'Yes, Proceed'],
        defaultId: 0,
        title: 'Confirm Migration Reset',
        message: 'Are you sure you want to force re-run all migrations?',
        detail: 'This action is irreversible. It will delete the migration history from both the local and server databases and restart the application. All migrations will be re-applied on startup.'
      });

      if (result.response === 1) { // Corresponds to 'Yes, Proceed'
        try {
          await this.databaseService.resetMysqlMigrations();
        } catch (err) {
          await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
            type: 'error',
            buttons: ['OK'],
            defaultId: 0,
            title: 'MySQL Reset Failed',
            message: 'Could not reset MySQL migration history.',
            detail: `Error: ${err?.message ?? err}\n\nThe application was not restarted because MySQL migrations would be skipped again. Check the MySQL connection and try re-running migrations.`
          });
          return;
        }
        // Reset local migration history and restart app
        await this.electronService.ipcRenderer.invoke('force-rerun-migrations');
      }
    } catch (error) {
      console.error('Error showing confirmation dialog:', error);
    }
  }

  public async reviewApplicationLogCleanup(): Promise<void> {
    if (this.logCleanupBusy) return;
    this.logCleanupBusy = true;
    this.logCleanupMessage = '';

    try {
      const preview = await this.databaseService.previewApplicationLogCleanup();
      const deletableRows = preview.local.deletableRows
        + (preview.mysql.available ? preview.mysql.deletableRows : 0);

      if (deletableRows === 0) {
        const mysqlNote = preview.mysql.available ? '' : ' The MySQL copy could not be checked.';
        this.logCleanupMessage = `Nothing to clean up. Recent logs are being kept.${mysqlNote}`;
        return;
      }

      const mysqlDetail = preview.mysql.available
        ? preview.mysql.deletableRows
        : 0;
      const totalDeletableRows = preview.local.deletableRows + mysqlDetail;
      const unavailableNote = preview.mysql.available
        ? ''
        : '\n\nThe MySQL copy is unavailable and will not be changed.';
      const confirmation = await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
        type: 'warning',
        buttons: ['Cancel', 'Delete Old Logs'],
        defaultId: 0,
        cancelId: 0,
        title: 'Confirm Log Cleanup',
        message: `Remove ${totalDeletableRows.toLocaleString()} old log entries?`,
        detail: `Logs from the seven most recent days of activity will be kept. Test results, raw analyzer data, and usage statistics are not affected.${unavailableNote}\n\nThis action cannot be undone.`
      });
      if (confirmation?.response !== 1) return;

      const result = await this.databaseService.cleanupOldApplicationLogs();
      const mysqlResult = result.mysqlAvailable
        ? ` ${result.mysqlDeletedRows.toLocaleString()} MySQL log entries were also removed.`
        : ' The optional MySQL log copy was unavailable and was not changed.';
      this.logCleanupMessage = `${result.localDeletedRows.toLocaleString()} local log entries removed.${mysqlResult}`;
      await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Log Cleanup Complete',
        message: 'Old application logs were cleaned safely.',
        detail: this.logCleanupMessage
      });
    } catch (error) {
      this.logCleanupMessage = 'Log cleanup could not be completed.';
      await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
        type: 'error',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Log Cleanup Failed',
        message: this.logCleanupMessage,
        detail: `No result or raw analyzer data was changed. Error: ${error?.message ?? error}`
      });
    } finally {
      this.logCleanupBusy = false;
    }
  }


  createInstrumentFormGroup(): FormGroup {
    const instrumentId = uuidv4();
    return this.formBuilder.group({
      id: instrumentId,
      analyzerMachineType: ['', Validators.required],
      interfaceCommunicationProtocol: ['', Validators.required],
      analyzerMachineName: ['', Validators.required],
      analyzerMachineHost: ['', Validators.required],
      analyzerMachinePort: ['', [
        Validators.required,
        Validators.pattern('^[0-9]+$'),
        (control) => {
          const value = control.value;
          if (!value) return null;
          const portNum = parseInt(value);
          return (isNaN(portNum) || portNum < 1 || portNum > 65535) ? { pattern: true } : null;
        }
      ]],
      interfaceConnectionMode: ['', Validators.required],
      displayorder: ['']
    });
  }

  getMachineIps(): string[] {
    const os = (window as any).require('os');
    const networkInterfaces = os.networkInterfaces();
    const ips = [];


    for (let interfaceName in networkInterfaces) {
      const iface = networkInterfaces[interfaceName];
      for (let i = 0; i < iface.length; i++) {
        const alias = iface[i];
        if (alias.family === 'IPv4' && !alias.internal) {
          ips.push(alias.address);
        }
      }
    }

    // Adding 127.0.0.1 as a default option
    ips.push('127.0.0.1');

    return ips;
  }


  addInstrument(): void {
    const newInstrument = this.formBuilder.group({
      analyzerMachineType: ['', Validators.required],
      interfaceCommunicationProtocol: ['', Validators.required],
      analyzerMachineName: ['', Validators.required],
      analyzerMachineHost: ['', Validators.required],
      analyzerMachinePort: ['', [
        Validators.required,
        Validators.pattern('^[0-9]+$'),
        (control) => {
          const value = control.value;
          if (!value) return null;
          const portNum = parseInt(value);
          return (isNaN(portNum) || portNum < 1 || portNum > 65535) ? { pattern: true } : null;
        }
      ]],
      interfaceConnectionMode: ['', Validators.required],
      displayorder: ['']
    });

    this.instrumentsSettings.push(newInstrument);
  }

  confirmRemoval(index: number, analyzerMachineName: string, event: Event): void {
    event.preventDefault();
    const confirmed = window.confirm(`Are you sure you want to remove ${analyzerMachineName}?`);
    if (confirmed) {
      this.removeInstrument(index);
    }
  }


  removeInstrument(index: number): void {
    this.instrumentsSettings.removeAt(index);
  }

  resetInstrumentVariables(): void {
    this.instrumentsSettings.controls.forEach(control => {
      control.reset({
        analyzerMachineType: '',
        interfaceCommunicationProtocol: '',
        analyzerMachineName: '',
        analyzerMachineHost: '',
        analyzerMachinePort: '',
        interfaceConnectionMode: '',
        displayorder: ''
      });
    });
    console.log('Reset instrument variables.');
  }

  updateSettings(): void {
    const that = this;
    if (that.settingsForm.valid) {
      // Store the form values before disconnecting instruments
      const updatedSettings = JSON.parse(JSON.stringify(that.settingsForm.value));

      // Encrypt the MySQL password before saving
      updatedSettings.commonSettings.mysqlPassword = this.cryptoService.encrypt(updatedSettings.commonSettings.mysqlPassword);

      // Encrypt LIS API credentials before saving
      const lisApiConfig = JSON.parse(JSON.stringify(updatedSettings.lisApiSettings));
      if (lisApiConfig.credentials) {
        lisApiConfig.credentials.token = this.cryptoService.encrypt(lisApiConfig.credentials.token || '');
        lisApiConfig.credentials.username = this.cryptoService.encrypt(lisApiConfig.credentials.username || '');
        lisApiConfig.credentials.password = this.cryptoService.encrypt(lisApiConfig.credentials.password || '');
        lisApiConfig.credentials.apiKey = this.cryptoService.encrypt(lisApiConfig.credentials.apiKey || '');
      }

      // Ensure all required keys exist in each instrument setting
      updatedSettings.instrumentsSettings = updatedSettings.instrumentsSettings.map(instrument => {
        const defaultInstrument = {
          analyzerMachineType: '',
          interfaceCommunicationProtocol: '',
          analyzerMachineName: '',
          analyzerMachineHost: '',
          analyzerMachinePort: '',
          interfaceConnectionMode: '',
          displayorder: ''
        };
        return { ...defaultInstrument, ...instrument };
      });

      // Show save in progress notification
      const savingNotification = document.createElement('div');
      savingNotification.textContent = 'Saving settings...';
      savingNotification.style.position = 'fixed';
      savingNotification.style.top = '20px';
      savingNotification.style.left = '50%';
      savingNotification.style.transform = 'translateX(-50%)';
      savingNotification.style.padding = '8px 16px';
      savingNotification.style.backgroundColor = 'rgba(0,0,0,0.7)';
      savingNotification.style.color = 'white';
      savingNotification.style.borderRadius = '4px';
      savingNotification.style.zIndex = '1000';
      document.body.appendChild(savingNotification);

      // First, disconnect all instruments if settings are being updated
      // This ensures clean connection state when settings change
      const activeInstruments = Array.from(this.availableInstruments);
      const disconnectPromises = activeInstruments
        .filter(instrument => instrument.isConnected)
        .map(instrument => {
          return new Promise<void>(resolve => {
            this.connectionManagerService.disconnect(instrument);
            // Resolve after a short delay to ensure disconnect has time to process
            setTimeout(() => resolve(), 100);
          });
        });

      // Wait for all disconnections to complete
      Promise.all(disconnectPromises).then(() => {
        // Save settings to electron store
        that.electronStoreService.set('commonConfig', updatedSettings.commonSettings);
        that.electronStoreService.set('instrumentsConfig', updatedSettings.instrumentsSettings);
        that.electronStoreService.set('lisApiConfig', lisApiConfig);

        // Remove the saving notification
        document.body.removeChild(savingNotification);

        // Show success notification
        new window.Notification('Success', {
          body: 'Updated Interface Tool settings'
        });

        // IMPORTANT: Set a flag in localStorage to indicate we're returning from settings
        localStorage.setItem('returnFromSettings', 'true');

        // IMPORTANT: Also set a session storage key as a backup (sometimes localStorage survives refreshes)
        sessionStorage.setItem('returnFromSettings', 'true');

        // Set a global variable as a backup (window level)
        (window as any).returnFromSettings = true;

        // Navigate back to console after a brief delay to allow settings to take effect
        setTimeout(() => {
          that.router.navigate(['/console'], {
            state: { returnFromSettings: true }
          });
        }, 500);
      });
    } else {
      console.error('Unable to update settings.');

      // Show validation errors
      const controlsWithErrors = this.findInvalidControls(this.settingsForm);
      console.log('Fields with validation errors:', controlsWithErrors);

      // Highlight invalid fields (optional)
      this.markInvalidControlsAsTouched(this.settingsForm);

      // Show error notification
      const errorNotification = document.createElement('div');
      errorNotification.textContent = 'Please fix the validation errors before saving';
      errorNotification.style.position = 'fixed';
      errorNotification.style.top = '20px';
      errorNotification.style.left = '50%';
      errorNotification.style.transform = 'translateX(-50%)';
      errorNotification.style.padding = '8px 16px';
      errorNotification.style.backgroundColor = 'rgba(220,53,69,0.9)';
      errorNotification.style.color = 'white';
      errorNotification.style.borderRadius = '4px';
      errorNotification.style.zIndex = '1000';
      document.body.appendChild(errorNotification);

      setTimeout(() => {
        document.body.removeChild(errorNotification);
      }, 5000);
    }
  }

  // Helper method to find invalid controls
  findInvalidControls(formGroup: FormGroup | FormArray): string[] {
    const invalid = [];
    const controls = formGroup.controls;

    for (const name in controls) {
      if (controls[name].invalid) {
        if (controls[name] instanceof FormGroup || controls[name] instanceof FormArray) {
          const childInvalid = this.findInvalidControls(controls[name] as FormGroup | FormArray);
          if (childInvalid.length > 0) {
            invalid.push(`${name} (${childInvalid.join(', ')})`);
          }
        } else {
          invalid.push(name);
        }
      }
    }

    return invalid;
  }

  // Helper method to mark all controls as touched to show validation errors
  markInvalidControlsAsTouched(formGroup: FormGroup | FormArray) {
    Object.keys(formGroup.controls).forEach(key => {
      const control = formGroup.get(key);

      if (control instanceof FormGroup || control instanceof FormArray) {
        this.markInvalidControlsAsTouched(control);
      } else if (control.invalid) {
        control.markAsTouched();
      }
    });
  }

  checkMysqlConnection() {
    const that = this;
    const commonSettings = that.settingsForm.get('commonSettings').value;
    const mysqlParams = {
      host: commonSettings.mysqlHost,
      user: commonSettings.mysqlUser,
      password: commonSettings.mysqlPassword,
      port: commonSettings.mysqlPort
    };

    that.utilitiesService.checkMysqlConnection(
      mysqlParams,
      () => {
        that.electronService.openDialog('showMessageBox', {
          type: 'info',
          message: 'MySQL Connected successfully. Please click on SAVE SETTINGS to update these settings.'
        });
      },
      (err: string) => {
        that.electronService.openDialog('showMessageBox', {
          type: 'error',
          message: `Unable to connect to MySQL database on host ${commonSettings.mysqlHost}`,
          detail: `${err}\n\nPlease check if all the database connection settings are correct and MySQL server is running.`
        });
      }
    );
  }
  cleanPortNumber(event: any, index: any): void {
    const input = event.target;
    const originalValue = input.value;

    // Remove non-numeric characters
    const numericValue = originalValue.replace(/[^0-9]/g, '');

    // If the value changed (non-numeric characters were found)
    if (originalValue !== numericValue) {
      // Get current cursor position
      const start = input.selectionStart;

      // Update the form control value based on whether this is an instrument port or MySQL port
      if (index === 'mysqlPort') {
        this.settingsForm.get('commonSettings.mysqlPort').setValue(numericValue);
      } else {
        this.instrumentsSettings.at(index).get('analyzerMachinePort').setValue(numericValue);
      }

      // After Angular updates the DOM, restore cursor position
      setTimeout(() => {
        // Adjust cursor position based on how many characters were removed
        const newPosition = Math.max(0, start - (originalValue.length - numericValue.length));
        input.setSelectionRange(newPosition, newPosition);
      }, 0);
    }

    // Validate range (1-65535)
    if (numericValue) {
      const portNum = parseInt(numericValue);
      if (portNum < 1 || portNum > 65535) {
        if (index === 'mysqlPort') {
          this.settingsForm.get('commonSettings.mysqlPort').setErrors({ pattern: true });
        } else {
          this.instrumentsSettings.at(index).get('analyzerMachinePort').setErrors({ pattern: true });
        }
      }
    }
  }

  // Add to your SettingsComponent class
  copyToClipboard(text: string): void {
    navigator.clipboard.writeText(text)
      .then(() => {
        // Optional: show a small notification that copying was successful
        const notification = document.createElement('div');
        notification.textContent = 'Copied to clipboard!';
        notification.style.position = 'fixed';
        notification.style.bottom = '20px';
        notification.style.left = '50%';
        notification.style.transform = 'translateX(-50%)';
        notification.style.padding = '8px 16px';
        notification.style.backgroundColor = 'rgba(0,0,0,0.7)';
        notification.style.color = 'white';
        notification.style.borderRadius = '4px';
        notification.style.zIndex = '1000';

        document.body.appendChild(notification);

        setTimeout(() => {
          document.body.removeChild(notification);
        }, 2000);
      })
      .catch(err => {
        console.error('Could not copy text: ', err);
      });
  }

  // Password visibility toggle
  togglePasswordVisibility(): void {
    const passwordField = document.querySelector('[name=mysqlPassword]') as HTMLInputElement;
    if (passwordField) {
      passwordField.type = passwordField.type === 'password' ? 'text' : 'password';
    }
  }

  /**
   * Two kinds of export. The plain one is the long-standing behaviour and
   * omits credentials; the full one includes them and is therefore only ever
   * written encrypted under a passphrase the user supplies.
   */
  async exportSettings(): Promise<void> {
    const choice = await this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
      type: 'question',
      buttons: ['Cancel', 'Settings Only', 'Settings and Credentials'],
      defaultId: 1,
      cancelId: 0,
      title: 'Export Settings',
      message: 'What should the exported file contain?',
      detail:
        'Settings Only — instruments, database host and LIS configuration. Passwords are left out, so they must be re-entered after restoring. The file is plain JSON.\n\n'
        + 'Settings and Credentials — everything above plus the database password and LIS credentials. The file is encrypted with a passphrase you choose and cannot be restored without it.\n\n'
        + 'Neither option includes this installation\'s identity, so a restored copy registers as a separate installation.'
    });

    if (choice?.response === 1) {
      const response = await this.electronStoreService.exportSettings({ includeCredentials: false });
      await this.reportExportResult(response);
      return;
    }

    if (choice?.response === 2) {
      this.passphrasePrompt = { mode: 'export', passphrase: '', confirmPassphrase: '', error: '' };
    }
  }

  /**
   * Reads the chosen file's envelope first, so the passphrase is only asked
   * for when the file actually needs one.
   */
  async importSettings(): Promise<void> {
    const inspected = await this.electronService.ipcRenderer.invoke('inspect-settings-file');

    if (inspected?.status === 'cancelled') return;

    if (inspected?.status !== 'success') {
      await this.showBackupDialog('error', 'Import Failed', 'That file could not be read as a settings export.', inspected?.message);
      return;
    }

    if (inspected.encrypted) {
      this.passphrasePrompt = {
        mode: 'import',
        passphrase: '',
        confirmPassphrase: '',
        error: '',
        filePath: inspected.filePath
      };
      return;
    }

    await this.applyImport({ filePath: inspected.filePath });
  }

  async submitPassphrase(): Promise<void> {
    const prompt = this.passphrasePrompt;
    if (!prompt) return;

    if (prompt.passphrase.length < this.minPassphraseLength) {
      prompt.error = `Use at least ${this.minPassphraseLength} characters.`;
      return;
    }

    if (prompt.mode === 'export' && prompt.passphrase !== prompt.confirmPassphrase) {
      prompt.error = 'The two passphrases do not match.';
      return;
    }

    prompt.error = '';
    this.backupBusy = true;

    try {
      if (prompt.mode === 'export') {
        const response = await this.electronStoreService.exportSettings({
          includeCredentials: true,
          passphrase: prompt.passphrase
        });
        this.passphrasePrompt = null;
        await this.reportExportResult(response);
        return;
      }

      const response = await this.applyImport({
        filePath: prompt.filePath,
        passphrase: prompt.passphrase
      });

      // A wrong passphrase keeps the modal open so it can be retried without
      // picking the file again.
      if (response?.status === 'error') {
        prompt.error = response.message;
        return;
      }
      this.passphrasePrompt = null;
    } finally {
      this.backupBusy = false;
    }
  }

  cancelPassphrasePrompt(): void {
    this.passphrasePrompt = null;
  }

  private async applyImport(options: { filePath: string; passphrase?: string }): Promise<any> {
    const response = await this.electronService.ipcRenderer.invoke('import-settings', options);

    if (response?.status === 'success') {
      await this.showBackupDialog('info', 'Import Complete', 'Settings were imported.', response.message);
      // Reload so every service picks the new settings up from the store.
      window.location.reload();
    } else if (response?.status === 'error') {
      // Reported by the caller when a retry is possible; shown here otherwise.
      if (!options.passphrase) {
        await this.showBackupDialog('error', 'Import Failed', 'Settings could not be imported.', response.message);
      }
    }

    return response;
  }

  private async reportExportResult(response: any): Promise<void> {
    if (!response || response.status === 'cancelled') return;

    await this.showBackupDialog(
      response.status === 'success' ? 'info' : 'error',
      response.status === 'success' ? 'Export Complete' : 'Export Failed',
      response.status === 'success' ? 'The settings file was written.' : 'The settings file could not be written.',
      response.message
    );
  }

  private showBackupDialog(type: string, title: string, message: string, detail?: string): Promise<any> {
    return this.electronService.ipcRenderer.invoke('show-confirm-dialog', {
      type,
      buttons: ['OK'],
      defaultId: 0,
      title,
      message,
      detail: detail ?? ''
    });
  }

  async loadBackupStatus(): Promise<void> {
    try {
      const status = await this.electronService.ipcRenderer.invoke('get-backup-config');
      this.backupConfig = status.config;
      this.backupDirectory = status.directory;
      this.lastBackupAt = status.lastBackupAt;
      this.lastCheckedAt = status.lastCheckedAt;
      this.backupCount = status.backupCount;
    } catch (error) {
      console.error('Could not read the backup configuration:', error);
    }
  }

  async updateBackupConfig(patch: Partial<SettingsBackupConfig>): Promise<void> {
    this.backupBusy = true;
    try {
      const response = await this.electronService.ipcRenderer.invoke('set-backup-config', patch);
      if (response?.config) this.backupConfig = response.config;
      await this.loadBackupStatus();
    } finally {
      this.backupBusy = false;
    }
  }

  onBackupEnabledChange(enabled: boolean): void {
    void this.updateBackupConfig({ enabled });
  }

  onBackupIntervalChange(interval: SettingsBackupInterval): void {
    void this.updateBackupConfig({ interval });
  }

  onBackupRetentionChange(retention: string | number): void {
    void this.updateBackupConfig({ retention: Number(retention) });
  }

  async runBackupNow(): Promise<void> {
    if (this.backupBusy) return;
    this.backupBusy = true;
    this.backupMessage = '';
    try {
      const response = await this.electronService.ipcRenderer.invoke('run-backup-now');
      if (response?.status !== 'success') {
        this.backupMessage = 'The backup could not be written.';
      } else {
        this.backupMessage = response.written
          ? 'Backup written.'
          : 'Settings are unchanged since the last backup, so nothing new was written.';
      }
      await this.loadBackupStatus();
    } finally {
      this.backupBusy = false;
    }
  }

  openBackupFolder(): void {
    void this.electronService.ipcRenderer.invoke('open-backup-folder');
  }

}
