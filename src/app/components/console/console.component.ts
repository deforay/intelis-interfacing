// src/app/components/console/console.component.ts

import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ElectronStoreService } from '../../services/electron-store.service';
import { InstrumentInterfaceService } from '../../services/instrument-interface.service';
import { UtilitiesService } from '../../services/utilities.service';
import { UpdateCheckService } from '../../services/update-check.service';
import { TcpConnectionService } from '../../services/tcp-connection.service';
import { ConnectionManagerService } from '../../services/connection-manager.service';
import { ConnectionParams } from '../../interfaces/connection-params.interface';
import { MatPaginator } from '@angular/material/paginator';
import { MatTableDataSource } from '@angular/material/table';
import { MatSort } from '@angular/material/sort';
import { SelectionModel } from "@angular/cdk/collections";
import { MatCheckboxChange } from '@angular/material/checkbox';
import { catchError, forkJoin, fromEvent, of, Subscription } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { debounceTime, distinctUntilChanged, map } from 'rxjs/operators';
import { LogDisplayService, LogEntry } from '../../services/log-display.service';
import { BACKGROUND_INTERVAL_MS, LIMS_SYNC_STATUS } from '../../constants/domain.constants';
import { resultStatusDisplay, ResultStatusDisplay } from '../../../../shared/result-status';
import { TransmissionDialogComponent } from '../transmission-dialog/transmission-dialog.component';

export enum SelectType {
  single,
  multiple
}

type LogLevelFilter = LogEntry['type'] | 'all';

@Component({
  standalone: false,
  selector: 'app-console',
  templateUrl: './console.component.html',
  styleUrls: ['./console.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConsoleComponent implements OnInit, AfterViewInit, OnDestroy {
  private static readonly SYSTEM_LOG_ID = '__system__';
  // Caps live-log re-renders at ~10/s. Uses a timer rather than an animation
  // frame so logs keep rendering while the window is hidden or minimised.
  private static readonly LOG_RENDER_INTERVAL_MS = 100;
  /** The longest a restart for an installed update waits for analyzers that are sending. */
  private static readonly MAX_RESTART_WAIT_SECONDS = 120;
  private logRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private viewDestroyed = false;
  searchTerm: string = '';
  private pickedInitialTab = false; // run-once guard
  public commonSettings = null;
  public instrumentsSettings = null;
  public appVersion: string = null;
  /** The newer release to mention, or null when there is nothing to say. */
  public availableUpdate: { version: string } | null = null;
  /** A version installed under the running one, which a restart takes up. */
  public installedUpdate: { version: string } | null = null;
  /** True once the operator chose Later. The footer still says it. */
  public installedUpdateDeferred = false;
  public restartingForUpdate = false;
  /** Instruments the restart is waiting for. */
  public restartWaitingFor: string[] = [];
  private restartWaitTimer: ReturnType<typeof setInterval> | null = null;
  public lastLimsSync = '';
  public lastResultReceived = '';
  public recentResultsInterval: any; // Interval for fetching recent results
  public mysqlCheckInterval: any; // Interval for checking MySQL connection
  public mysqlConnected: boolean = false;  // To store the MySQL connection status
  /** False when no MySQL host is set. MySQL is optional. */
  public mysqlConfigured = false;
  public walCheckpointInterval: any; // Interval for performing SQLite WAL checkpoints
  public limsSyncPullInterval: any; // Interval for pulling LIMS sync status updates from MySQL
  public data: any;
  public lastOrders: any;
  public showScrollToTop = false;
  private readonly ipc: any;
  private updateSubscription: Subscription | null = null;
  private installedUpdateSubscription: Subscription | null = null;
  public availableInstruments = [];
  private readonly loadedLogInstrumentIds = new Set<string>();
  public instrumentLogs: { [instrumentId: string]: { logs: any[]; filteredLogs: any[] } } = {};
  public connectionParams: ConnectionParams = null;
  public selectedTabIndex = 0;
  private electronStoreSubscription: Subscription;
  private instrumentsSubscription: Subscription;
  private resultSavedSubscription: Subscription;
  private logSubscription: Subscription;
  private logClearSubscription: Subscription;
  private searchSubscription: Subscription;
  private initialResultsTimeout: ReturnType<typeof setTimeout>;
  private readonly visibilityChangeHandler = () => {
    if (document.visibilityState === 'visible') {
      this.checkConnectionsAfterInactivity();
    }
  };
  public systemLogsExpanded = false;
  public systemLogContext = {
    connectionParams: { instrumentId: ConsoleComponent.SYSTEM_LOG_ID },
    searchText: '',
    logLevel: 'all' as LogLevelFilter
  };
  public readonly logLevelOptions: Array<{ value: LogLevelFilter; label: string }> = [
    { value: 'all', label: 'All logs' },
    { value: 'error', label: 'Errors' },
    { value: 'warn', label: 'Warnings' },
    { value: 'success', label: 'Success' },
    { value: 'info', label: 'Info' },
    { value: 'verbose', label: 'Verbose' }
  ];

  private checkConnectionsAfterInactivity() {
    console.log('Checking connection status after inactivity');

    this.availableInstruments.forEach(instrument => {
      if (instrument.isConnected) {
        // Verify the connection - this will check socket state and update status
        const isActuallyConnected = this.tcpService.verifyConnection(instrument.connectionParams);

        if (!isActuallyConnected) {
          instrument.isConnected = false;
        }
      }
    });
  }

  public displayedColumns: string[] = [
    'select',
    'machine_used',
    'order_id',
    'results',
    'notes',
    'analysed_date_time',
    'added_on',
    'result_status_as_sent',
    'lims_sync_status',
    'original'
  ];
  /**
   * The columns actually shown: Notes only when a result on screen has one,
   * so an empty column does not push the sync status off the screen.
   */
  public visibleColumns: string[] = this.displayedColumns.filter(column => column !== 'notes');

  /** The Result Status column: what the analyzer said about the result. */
  resultStatus(row: any): ResultStatusDisplay {
    return resultStatusDisplay(row);
  }

  /**
   * The Synced to LIS column: what the LIS did with a captured result. The words
   * avoid "failed" and "rejected". In a laboratory those describe a test or a
   * sample, and this column is about neither.
   */
  limsStatus(row: any, answeredOn: string): { label: string; title: string; icon: string; state: 'received' | 'waiting' | 'could-not-sync' } {
    const on = answeredOn ? ` on ${answeredOn}` : '';
    switch (Number(row?.lims_sync_status)) {
      case LIMS_SYNC_STATUS.SYNCED:
        return { label: 'Yes', title: `The LIS received this result${on}.`, icon: 'fa-check', state: 'received' };
      case LIMS_SYNC_STATUS.PENDING:
        return { label: 'Not yet', title: 'The LIS has not taken this result yet.', icon: 'fa-clock', state: 'waiting' };
      default:
        return {
          label: 'Could not sync',
          title: `This result could not sync to the LIS${on}. The test result is unchanged. To send it again, select the row and press Re-sync Selected.`,
          icon: 'fa-exclamation-triangle',
          state: 'could-not-sync'
        };
    }
  }

  private visibleColumnsSubscription: Subscription | null = null;
  selectType = [
    { text: "Single", value: SelectType.single },
    { text: "Multiple", value: SelectType.multiple }
  ];
  selection = new SelectionModel<any>(true, []);
  displayType = SelectType.single;
  dataSource = new MatTableDataSource<any>();
  @ViewChild('topAnchor', { static: true }) topAnchor: ElementRef;
  @ViewChild('resultsSection', { static: false }) resultsSection: ElementRef;
  @ViewChild('searchInput', { static: true }) searchInput: ElementRef;
  @ViewChild(MatPaginator, { static: true }) paginator: MatPaginator;
  @ViewChild(MatSort, { static: true }) sort: MatSort;

  constructor(
    private readonly dialog: MatDialog,
    private readonly cdRef: ChangeDetectorRef,
    private readonly store: ElectronStoreService,
    private readonly _ngZone: NgZone,
    private readonly instrumentInterfaceService: InstrumentInterfaceService,
    private readonly connectionManagerService: ConnectionManagerService,
    private readonly tcpService: TcpConnectionService,
    private readonly utilitiesService: UtilitiesService,
    private readonly logDisplayService: LogDisplayService,
    private readonly snackBar: MatSnackBar,
    private readonly updateCheckService: UpdateCheckService,
    private readonly router: Router) {
    if ((<any>window).require) {
      this.ipc = (<any>window).require('electron').ipcRenderer;
    } else {
      console.warn('App not running inside Electron!');
    }
  }

  selectHandler(row: any, event: MatCheckboxChange) {
    if (row === null) {
      if (event.checked) {
        this.dataSource.data.forEach(row => this.selection.select(row));
      } else {
        this.selection.clear();
      }
    } else {
      this.selection.toggle(row);
    }
  }

  onChange(typeValue: number) {
    this.displayType = typeValue;
    this.selection.clear();
  }

  ngAfterViewInit() {
    // Setup debounced search after view is initialized and input element is available
    if (this.searchInput?.nativeElement) {
      this.searchSubscription = fromEvent(this.searchInput.nativeElement, 'input').pipe(
        map((event: any) => event.target.value),
        debounceTime(300), // Wait 300ms after last event
        distinctUntilChanged() // Only emit if value changed
      ).subscribe(value => {
        // Run in NgZone to trigger change detection
        this._ngZone.run(() => {
          this.filterData({ target: { value } });
        });
      });
    }
  }

  ngOnInit() {
    // Received On sorts by row id, the order results arrived. The stored time
    // has no zone, so it can run backwards across a time zone change.
    const sortValue = this.dataSource.sortingDataAccessor;
    this.dataSource.sortingDataAccessor = (row, column) =>
      column === 'added_on' && row?.id != null ? Number(row.id) : sortValue(row, column);
    this.visibleColumnsSubscription = this.dataSource.connect().subscribe(rows => {
      const hasNotes = rows.some(row => typeof row?.notes === 'string' && row.notes.trim() !== '');
      const columns = this.displayedColumns.filter(column => hasNotes || column !== 'notes');
      if (columns.length !== this.visibleColumns.length) {
        this.visibleColumns = columns;
      }
    });
    this.loadSettings();
    this.checkMysqlConnection();

    this.updateSubscription = this.updateCheckService.availableUpdate().subscribe(update => {
      this.availableUpdate = update;
      this.cdRef.detectChanges();
    });
    this.installedUpdateSubscription = this.updateCheckService.installedUpdate().subscribe(update => {
      this.installedUpdate = update;
      this.cdRef.detectChanges();
    });
    this.updateCheckService.start();

    // Scroll to the top of the page when the component initializes
    window.scrollTo(0, 0);

    document.addEventListener('visibilitychange', this.visibilityChangeHandler);

    // Subscribe to available instruments from the connection manager
    this.instrumentsSubscription = this.connectionManagerService.getActiveInstruments()
      .subscribe(instruments => {
        this._ngZone.run(() => {
          this.availableInstruments = instruments;

          // pick first connected tab once (or first item if none connected)
          if (!this.pickedInitialTab && this.availableInstruments?.length) {
            const idx = this.availableInstruments.findIndex(i => i?.isConnected === true);
            if (idx >= 0) {
              this.selectTab(idx);
              this.pickedInitialTab = true;
            } else if (this.selectedTabIndex >= this.availableInstruments.length) {
              // still ensure a valid tab if array changed
              this.selectTab(0);
            }
          }


          // Check if we should auto-reconnect instruments
          this.checkForAutoReconnect();

          // Load persisted logs only once per instrument. Re-loading on every
          // status tick can overwrite in-memory live HL7 logs before they persist.
          this.loadRecentLogsForNewInstruments(instruments);
          this.cdRef.detectChanges();
        });
      });

    // Fetch last few orders on load
    this.initialResultsTimeout = setTimeout(() => {
      this.fetchRecentResults();
    }, 600);

    // Refresh recent results when new samples are saved
    this.resultSavedSubscription = this.instrumentInterfaceService.resultSaved$
      .pipe(debounceTime(250))
      .subscribe(() => {
        this._ngZone.run(() => {
          this.refreshRecentResultsAfterSave();
        });
      });

    // Check MySQL connection on regular intervals
    this.mysqlCheckInterval = setInterval(() => {
      this.checkMysqlConnection();
    }, BACKGROUND_INTERVAL_MS.MYSQL_HEALTH);

    // Background refresh + MySQL resync every 5 minutes. New results trigger
    // an immediate refresh via resultSaved$, and the user can hit the refresh
    // button — this tick is just a safety net for idle periods.
    this.recentResultsInterval = setInterval(() => {
      this.fetchRecentResults();
      this.resyncTestResultsToMySQL();
      this.resyncTelemetryToMySQL();
      this.resyncIntelisStatusesToMySQL();
    }, BACKGROUND_INTERVAL_MS.RESULT_REFRESH);

    // Pull LIMS sync status from MySQL into SQLite every 30s. Any external
    // LIS integration (PHP, Python, Node, anything that can talk to MySQL)
    // writes lims_sync_status + lims_sync_date_time to the shared MySQL
    // orders table; this watermark sync surfaces those updates in the
    // console UI quickly. Cost when idle: two small indexed queries.
    this.limsSyncPullInterval = setInterval(() => {
      if (this.mysqlConnected) {
        this.utilitiesService.syncLimsStatusToSQLite(
          (result) => this._refreshOrdersDisplayAfterLimsPull(result),
          () => { }
        );
      }
    }, BACKGROUND_INTERVAL_MS.LIMS_STATUS_PULL);

    // SQLite WAL checkpoint every 30 minutes
    this.walCheckpointInterval = setInterval(() => {
      this.runSQLiteWalCheckpoint();
    }, BACKGROUND_INTERVAL_MS.WAL_CHECKPOINT);

    // Subscribe to logs from the display service
    this.logSubscription = this.logDisplayService.log$.subscribe(logEntry => {
      this._ngZone.run(() => {
        this.updateLogUI(logEntry);
      });
    });

    // Subscribe to clear events
    this.logClearSubscription = this.logDisplayService.clear$.subscribe(instrumentId => {
      this._ngZone.run(() => {
        if (instrumentId) {
          // Clear logs for a specific instrument
          if (this.instrumentLogs[instrumentId]) {
            this.instrumentLogs[instrumentId].logs = [];
            this.instrumentLogs[instrumentId].filteredLogs = [];
          }
        } else {
          // Clear all logs if no ID is specified
          Object.keys(this.instrumentLogs).forEach(id => {
            this.instrumentLogs[id].logs = [];
            this.instrumentLogs[id].filteredLogs = [];
          });
        }
        this.cdRef.detectChanges();
      });
    });

    this.loadRecentSystemLogs();
  }

  @HostListener('window:scroll')
  onWindowScroll(): void {
    this.showScrollToTop = window.scrollY > 500;
  }

  scrollToResults(): void {
    this.resultsSection?.nativeElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  scrollToTop(): void {
    this.topAnchor?.nativeElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  private updateLogUI(logEntry: LogEntry) {
    const instrumentId = this.isSystemLog(logEntry)
      ? ConsoleComponent.SYSTEM_LOG_ID
      : logEntry.instrumentId ?? ConsoleComponent.SYSTEM_LOG_ID;
    if (!instrumentId) return;

    const bucket = (this.instrumentLogs[instrumentId] ??= { logs: [], filteredLogs: [] });

    // Newest-first: prepend instead of push+sort. Logs arrive in chronological order.
    bucket.logs.unshift(logEntry);

    const MAX_LOG_ENTRIES = 1000;
    if (bucket.logs.length > MAX_LOG_ENTRIES) {
      bucket.logs.length = MAX_LOG_ENTRIES;
    }

    const searchText = this.getInstrumentSearchText(instrumentId);
    const logLevel = this.getInstrumentLogLevel(instrumentId);
    if (searchText || logLevel !== 'all') {
      if (this.logMatchesFilters(logEntry, searchText, logLevel)) {
        bucket.filteredLogs.unshift(logEntry);
        if (bucket.filteredLogs.length > MAX_LOG_ENTRIES) {
          bucket.filteredLogs.length = MAX_LOG_ENTRIES;
        }
      }
    } else {
      // No filter active — share the same array reference.
      bucket.filteredLogs = bucket.logs;
    }

    this.scheduleLogRender();
  }

  // WHY: a busy analyzer emits several log lines per TCP chunk (one per ASTM
  // frame ACK). Rendering each one synchronously ran a full change-detection
  // pass hundreds of times a second. The entries are already in the arrays, so
  // coalescing the render caps it without changing what is displayed.
  private scheduleLogRender(): void {
    if (this.logRenderTimer) {
      return;
    }

    this.logRenderTimer = setTimeout(() => {
      this.logRenderTimer = null;
      if (this.viewDestroyed) {
        return;
      }
      this.cdRef.detectChanges();
    }, ConsoleComponent.LOG_RENDER_INTERVAL_MS);
  }

  private isSystemLog(logEntry: LogEntry): boolean {
    return logEntry.category === 'system'
      || logEntry.category === 'database'
      || logEntry.category === 'migration';
  }

  private getInstrumentSearchText(instrumentId: string): string {
    if (instrumentId === ConsoleComponent.SYSTEM_LOG_ID) {
      return (this.systemLogContext.searchText || '').trim();
    }
    const instrument = this.availableInstruments?.find(
      i => i?.connectionParams?.instrumentId === instrumentId
    );
    return (instrument?.searchText || '').trim();
  }

  private getInstrumentLogLevel(instrumentId: string): LogLevelFilter {
    if (instrumentId === ConsoleComponent.SYSTEM_LOG_ID) {
      return this.systemLogContext.logLevel;
    }
    const instrument = this.availableInstruments?.find(
      i => i?.connectionParams?.instrumentId === instrumentId
    );
    return instrument?.logLevel || 'all';
  }

  private logMatchesFilters(log: LogEntry, searchText: string, logLevel: LogLevelFilter): boolean {
    const matchesLevel = logLevel === 'all' || log.type === logLevel;
    const matchesSearch = !searchText || log.message.toLowerCase().includes(searchText.toLowerCase());
    return matchesLevel && matchesSearch;
  }

  trackByLogId(_index: number, logEntry: LogEntry): number | string {
    return logEntry.id ?? `${logEntry.timestamp?.getTime()}-${_index}`;
  }

  private _refreshOrdersDisplayAfterLimsPull(result: { updatedCount: number; message: string }) {
    // Skip the table re-render when the pull found nothing new — keeps the
    // 30s tick effectively free while idle. When updates did land, refresh
    // the visible orders table and the "Last LIMS sync" badge.
    if (!result || result.updatedCount === 0) {
      return;
    }
    this._ngZone.run(() => {
      this.refreshRecentResultsAfterSave();
    });
  }

  private refreshRecentResultsAfterSave(): void {
    const trimmedSearch = (this.searchTerm || '').trim();

    const effectiveSearch = trimmedSearch.length >= 2 ? trimmedSearch : '';
    this.utilitiesService.fetchRecentResults(effectiveSearch).subscribe({
      next: (results) => {
        this._ngZone.run(() => {
          this.lastOrders = results;
          this.dataSource.data = this.lastOrders;
          this.cdRef.detectChanges();
        });
      },
      error: (err) => console.error('Error refreshing results after save:', err)
    });

    this.utilitiesService.fetchLastSyncTimes().subscribe({
      next: (data) => {
        this._ngZone.run(() => {
          this.lastLimsSync = this.utilitiesService.humanReadableDateTime(data.lastLimsSync);
          this.lastResultReceived = this.utilitiesService.humanReadableDateTime(data.lastResultReceived);
          this.cdRef.detectChanges();
        });
      },
      error: (err) => console.error('Error fetching last sync times:', err)
    });
  }

  private checkForAutoReconnect() {
    //console.log('Checking for auto-reconnect condition');

    // Check multiple sources for the returnFromSettings flag
    const navigation = this.router.getCurrentNavigation();
    const navigationState = navigation?.extras?.state?.returnFromSettings;
    const localStorageFlag = localStorage.getItem('returnFromSettings') === 'true';
    const sessionStorageFlag = sessionStorage.getItem('returnFromSettings') === 'true';
    const windowFlag = (window as any).returnFromSettings === true;

    // // Log all sources for debugging
    // console.log('Navigation state returnFromSettings:', navigationState);
    // console.log('localStorage returnFromSettings:', localStorageFlag);
    // console.log('sessionStorage returnFromSettings:', sessionStorageFlag);
    // console.log('window returnFromSettings:', windowFlag);

    // Use any of the sources
    const returnFromSettings = navigationState || localStorageFlag || sessionStorageFlag || windowFlag;

    // Clear all flags
    localStorage.removeItem('returnFromSettings');
    sessionStorage.removeItem('returnFromSettings');
    (window as any).returnFromSettings = false;

    if (returnFromSettings) {
      //console.log('Returning from settings, checking auto-connect instruments');

      // Add a slight delay to ensure component is fully loaded
      setTimeout(() => {
        // Use the service to reconnect all applicable instruments
        const reconnectedCount = this.connectionManagerService.reconnectAllAutoConnectInstruments();

        console.log(`Auto-reconnecting ${reconnectedCount} instrument(s)`);

        if (reconnectedCount > 0) {
          // Show a notification that reconnection is happening
          const notification = document.createElement('div');
          notification.textContent = `Auto-reconnecting ${reconnectedCount} instrument(s)...`;
          notification.style.position = 'fixed';
          notification.style.top = '20px';
          notification.style.left = '50%';
          notification.style.transform = 'translateX(-50%)';
          notification.style.padding = '8px 16px';
          notification.style.backgroundColor = 'rgba(0,0,0,0.7)';
          notification.style.color = 'white';
          notification.style.borderRadius = '4px';
          notification.style.zIndex = '1000';
          document.body.appendChild(notification);

          setTimeout(() => {
            notification.remove();
          }, 3000);
        }
      }, 1000); // Wait 1 second after component initialization
    }
  }

  loadSettings() {
    this.electronStoreSubscription = this.store.electronStoreObservable().subscribe(electronStoreObject => {
      this._ngZone.run(() => {
        this.commonSettings = electronStoreObject.commonConfig;
        this.instrumentsSettings = electronStoreObject.instrumentsConfig;
        this.appVersion = electronStoreObject.appVersion;
        this.cdRef.detectChanges();
      });
    });
  }

  /** Opens the records a result was read from and the transmission they came in. */
  showOriginal(row: any, event?: Event) {
    event?.stopPropagation();
    this.dialog.open(TransmissionDialogComponent, { data: row, width: '900px', maxWidth: '95vw' });
  }

  /**
   * Marks the selected results to be sent to the LIS again, then says how many
   * were marked. Synced to LIS shows Not yet until the LIS takes them.
   */
  reSyncSelectedRecords() {
    const selectedRows = [...this.selection.selected];
    if (selectedRows.length === 0) return;

    forkJoin(selectedRows.map(row =>
      this.utilitiesService.reSyncRecord(row.order_id).pipe(
        map(() => {
          row.lims_sync_status = '0';
          return true;
        }),
        catchError(error => {
          console.error('Error during re-sync:', error);
          return of(false);
        })
      )
    )).subscribe(outcomes => {
      const marked = outcomes.filter(Boolean).length;
      const notMarked = outcomes.length - marked;
      this.dataSource.data = [...this.dataSource.data];
      this.selection.clear();

      const resultWord = (count: number) => count === 1 ? 'result' : 'results';
      const message = notMarked === 0
        ? `${marked} ${resultWord(marked)} will sync to the LIS again.`
        : `${marked} ${resultWord(marked)} will sync to the LIS again. ${notMarked} could not be marked. Select them and press Re-sync Selected again.`;
      this._ngZone.run(() => {
        this.snackBar.open(message, undefined, {
          duration: 5000,
          horizontalPosition: 'end',
          verticalPosition: 'bottom'
        });
      });
      this.cdRef.detectChanges();
    });
  }

  fetchRecentResults(searchTerm?: string) {
    const trimmedTerm = (searchTerm || '').trim();

    // Only sync when NOT searching (i.e., when getting all results)
    if (trimmedTerm === '') {
      console.log('Fetching all results with sync');
      this.resyncTestResultsToMySQL();
    } else {
      console.log('Fetching search results without sync');
    }

    this.utilitiesService.fetchRecentResults(trimmedTerm).subscribe({
      next: lastFewOrders => {
        this._ngZone.run(() => {
          this.lastOrders = lastFewOrders;
          this.data = lastFewOrders;
          this.dataSource.data = this.lastOrders;
          this.dataSource.paginator = this.paginator;
          this.dataSource.sort = this.sort;

          this.sort.active = 'added_on';
          this.sort.direction = 'desc';
          this.sort.sortChange.emit({ active: this.sort.active, direction: this.sort.direction });

          this.cdRef.detectChanges();
        });
      },
      error: error => {
        console.error('Error fetching last orders:', error);
      }
    });

    this.utilitiesService.fetchLastSyncTimes().subscribe({
      next: (data) => {
        this.lastLimsSync = this.utilitiesService.humanReadableDateTime(data.lastLimsSync);
        this.lastResultReceived = this.utilitiesService.humanReadableDateTime(data.lastResultReceived);
      },
      error: (err) => console.error('Error fetching last sync times:', err)
    });
  }

  clearSearch() {
    console.log('Clearing search');
    this.searchTerm = '';
    if (this.searchInput?.nativeElement) {
      this.searchInput.nativeElement.value = '';
    }
    // Get all results without syncing (since it's just clearing search)
    this.searchResults('');
  }

  openModal() {
    this.ipc.send("openModal");
  }

  goToDashboard() {
    this.router.navigate(['/dashboard']);
  }

  /**
   * Search method - ONLY searches, no syncing
   */
  searchResults(searchTerm: string) {
    const trimmedTerm = (searchTerm || '').trim();

    console.log('Searching with trimmed term:', `"${trimmedTerm}"`);

    // Pass the trimmed term to the service
    this.utilitiesService.fetchRecentResults(trimmedTerm).subscribe({
      next: (results) => {
        this._ngZone.run(() => {
          this.lastOrders = results;
          this.data = results;
          this.dataSource.data = this.lastOrders;
          this.dataSource.paginator = this.paginator;
          this.dataSource.sort = this.sort;

          this.sort.active = 'added_on';
          this.sort.direction = 'desc';
          this.sort.sortChange.emit({ active: this.sort.active, direction: this.sort.direction });

          this.cdRef.detectChanges();

          console.log(`Search completed: ${this.lastOrders?.length || 0} results for "${trimmedTerm}"`);
        });
      },
      error: (error) => console.error('Error fetching search results:', error)
    });
  }

  /**
   * Refresh method - Syncs AND fetches all results
   */
  refreshResults() {
    console.log('Refreshing all results with sync');

    // Do the sync first, then fetch all results
    this.resyncTestResultsToMySQL();
    this.utilitiesService.fetchRecentResults('').subscribe({
      next: (results) => {
        this._ngZone.run(() => {
          this.lastOrders = results;
          this.data = results;
          this.dataSource.data = this.lastOrders;
          this.dataSource.paginator = this.paginator;
          this.dataSource.sort = this.sort;

          this.sort.active = 'added_on';
          this.sort.direction = 'desc';
          this.sort.sortChange.emit({ active: this.sort.active, direction: this.sort.direction });

          this.cdRef.detectChanges();
        });
      },
      error: (error) => console.error('Error fetching refreshed results:', error)
    });

    this.utilitiesService.fetchLastSyncTimes().subscribe({
      next: (data) => {
        this.lastLimsSync = this.utilitiesService.humanReadableDateTime(data.lastLimsSync);
        this.lastResultReceived = this.utilitiesService.humanReadableDateTime(data.lastResultReceived);
      },
      error: (err) => console.error('Error fetching last sync times:', err)
    });
  }

  filterData($event: any) {
    const rawSearchTerm = $event.target.value || '';
    const trimmedSearchTerm = rawSearchTerm.trim();

    // Update the model with trimmed value for consistency
    this.searchTerm = trimmedSearchTerm;

    console.log('Search input:', {
      raw: `"${rawSearchTerm}"`,
      trimmed: `"${trimmedSearchTerm}"`,
      length: trimmedSearchTerm.length
    });

    if (trimmedSearchTerm === '') {
      // Empty or whitespace-only search - get all results WITHOUT syncing
      console.log('Empty search - fetching all results without sync');
      this.searchResults('');
    } else if (trimmedSearchTerm.length >= 2) {
      // Valid search term - perform search
      console.log('Valid search term - performing search');
      this.searchResults(trimmedSearchTerm);
    } else {
      // Single character - don't search (avoid too many requests)
      console.log('Search term too short - ignoring');
      // Optionally clear results or keep current results
      // this.dataSource.data = []; // Uncomment if you want to clear on single char
    }
  }

  updateLogsForInstrument(instrumentId: string, newLogs: LogEntry[]) {
    this.instrumentLogs[instrumentId] ??= {
      logs: [],
      filteredLogs: []
    };

    // Sort logs by timestamp descending (newest first)
    newLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    this.instrumentLogs[instrumentId].logs = newLogs;
    this.filterInstrumentLogs({ connectionParams: { instrumentId } });
  }

  get systemLogs() {
    return this.instrumentLogs[ConsoleComponent.SYSTEM_LOG_ID];
  }

  get systemLogCount(): number {
    return this.systemLogs?.filteredLogs?.length ?? 0;
  }

  /**
   * True when a warning or an error is in the System Logs. Routine information
   * there is not a reason to look, so it does not turn the button into an alert.
   */
  get systemLogHasAlerts(): boolean {
    return this.systemLogs?.logs?.some(log => log.type === 'error' || log.type === 'warn') ?? false;
  }

  toggleSystemLogs(): void {
    this.systemLogsExpanded = !this.systemLogsExpanded;
  }

  /** Escape closes the log drawer wherever focus is. */
  @HostListener('document:keydown.escape')
  closeSystemLogsOnEscape(): void {
    if (this.systemLogsExpanded) {
      this.systemLogsExpanded = false;
    }
  }

  private loadRecentLogsForNewInstruments(instruments: any[]) {
    instruments.forEach(instrument => {
      const instrumentId = instrument?.connectionParams?.instrumentId;
      if (!instrumentId || this.loadedLogInstrumentIds.has(instrumentId)) {
        return;
      }

      this.loadedLogInstrumentIds.add(instrumentId);
      this.utilitiesService.fetchRecentLogs(instrumentId)
        .subscribe(logs => {
          this._ngZone.run(() => {
            this.updateLogsForInstrument(instrumentId, logs);
          });
        });
    });
  }

  private loadRecentSystemLogs(): void {
    this.utilitiesService.fetchRecentSystemLogs()
      .subscribe(logs => {
        this._ngZone.run(() => {
          this.updateLogsForInstrument(ConsoleComponent.SYSTEM_LOG_ID, logs);
        });
      });
  }

  // Use connection manager service for connect/disconnect functions
  connect(instrument: any) {
    this.connectionManagerService.connect(instrument);
  }

  reconnect(instrument: any) {
    this.connectionManagerService.reconnect(instrument);
  }

  disconnect(instrument: any) {
    this.connectionManagerService.disconnect(instrument);
  }

  sendASTMOrders(instrument: any) {
    this.connectionManagerService.sendASTMOrders(instrument);
  }

  selectTab(index: number): void {
    this.selectedTabIndex = index;
    // Force status refresh when selecting a tab
    if (this.availableInstruments && this.availableInstruments.length > 0) {
      const instrument = this.availableInstruments[index];
      if (instrument) {
        this.syncConnectionStatus(instrument);
      }
    }
  }

  syncConnectionStatus(instrument: any) {
    //console.log(`Manually syncing status for ${instrument.connectionParams.instrumentId}`);
    this.connectionManagerService.refreshConnectionStatus(instrument);
  }

  filterInstrumentLogs(instrument: any) {
    if (!this.instrumentLogs[instrument.connectionParams.instrumentId]) {
      // Initialize the logs structure for the instrument if not already done
      this.instrumentLogs[instrument.connectionParams.instrumentId] = {
        logs: [],
        filteredLogs: []
      };
    }

    const bucket = this.instrumentLogs[instrument.connectionParams.instrumentId];
    const searchText = (instrument.searchText || '').trim();
    const logLevel: LogLevelFilter = instrument.logLevel || 'all';
    if (searchText || logLevel !== 'all') {
      bucket.filteredLogs = bucket.logs.filter((log: LogEntry) =>
        this.logMatchesFilters(log, searchText, logLevel)
      );
    } else {
      // No filter — share the reference so a new log doesn't force a full copy.
      bucket.filteredLogs = bucket.logs;
    }

    this.cdRef.detectChanges(); // Trigger change detection if needed
  }

  setLogLevel(instrument: any, logLevel: LogLevelFilter): void {
    instrument.logLevel = logLevel;
    this.filterInstrumentLogs(instrument);
  }

  copyLog(instrument: { connectionParams: { instrumentId: string | number; }; }) {
    if (this.instrumentLogs[instrument.connectionParams.instrumentId]) {
      const logContent = this.instrumentLogs[instrument.connectionParams.instrumentId].filteredLogs
        .map((logEntry: LogEntry) => {
          const timestamp = this.formatLogTimestamp(logEntry.timestamp);
          return `[${timestamp}] [${logEntry.type}] ${logEntry.message}`;
        })
        .join('\n');
      this.copyTextToClipboard(logContent);
    } else {
      console.error('No logs found for instrument:', instrument.connectionParams.instrumentId);
    }
  }

  private formatLogTimestamp(timestamp: Date): string {
    const value = new Date(timestamp);
    const pad = (part: number, length = 2) => String(part).padStart(length, '0');

    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} `
      + `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
  }

  /**
   * Empties this log viewer. The log files and the stored log are unchanged,
   * which the button and the message both say: a red "Clear" beside "Delete
   * Old Logs" in Settings read as deleting.
   */
  clearLiveLog(instrument: any) {
    const instrumentId = instrument.connectionParams.instrumentId;
    // This will trigger the subscription to clear the UI
    this.logDisplayService.clearLogs(instrumentId);
    this._ngZone.run(() => {
      this.snackBar.open('Cleared from view. The log files are unchanged.', undefined, {
        duration: 3000,
        horizontalPosition: 'end',
        verticalPosition: 'bottom'
      });
    });
  }

  resyncTestResultsToMySQL() {
    if (this.mysqlConnected) {
      this.utilitiesService.resyncTestResultsToMySQL(
        (message: any) => {
          console.log(message);
        },
        (error: any) => {
          console.error(error);
        }
      );
      this.utilitiesService.syncLimsStatusToSQLite(
        (result) => this._refreshOrdersDisplayAfterLimsPull(result),
        (error: any) => {
          console.error(error);
        }
      );
    }
  }

  resyncIntelisStatusesToMySQL() {
    this.utilitiesService.resyncIntelisStatusesToMySQL(() => {}, () => {});
  }

  resyncTelemetryToMySQL() {
    if (!this.mysqlConnected) return;

    this.utilitiesService.resyncTelemetryToMySQL(
      (message: string) => console.log(message),
      (error: any) => console.error('Usage statistics MySQL synchronization failed:', error)
    );
  }

  copyTextToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      this._ngZone.run(() => {
        this.snackBar.open('Logs copied to clipboard', undefined, {
          duration: 3000,
          horizontalPosition: 'end',
          verticalPosition: 'bottom'
        });
      });
    }, (err) => {
      console.error('Error in copying text: ', err);
      this._ngZone.run(() => {
        this.snackBar.open('Failed to copy logs', undefined, {
          duration: 3000,
          horizontalPosition: 'end',
          verticalPosition: 'bottom'
        });
      });
    });
  }

  checkMysqlConnection() {
    const commonSettings = this.store.get('commonConfig');
    this.mysqlConfigured = !!commonSettings?.mysqlHost?.trim();
    if (!this.mysqlConfigured) {
      this.mysqlConnected = false;
      this.cdRef.detectChanges();
      return;
    }
    const mysqlParams = {
      host: commonSettings.mysqlHost,
      user: commonSettings.mysqlUser,
      password: commonSettings.mysqlPassword,
      port: commonSettings.mysqlPort
    };

    this.utilitiesService.checkMysqlConnection(
      mysqlParams,
      () => {
        this.mysqlConnected = true;
        this.cdRef.detectChanges();
      },
      (err) => {
        this.mysqlConnected = false;
        this.cdRef.detectChanges();
      }
    );
  }

  runSQLiteWalCheckpoint(): void {
    this.utilitiesService.sqlite3WalCheckpoint();
    // Routine upkeep every 30 minutes. Nothing for an operator to act on.
    console.log('SQLite WAL checkpoint scheduled and executed');
  }

  cancelConnection(instrument: any) {
    this.connectionManagerService.cancelConnection(instrument);
  }

  forceRestartConnection(instrument: any) {
    this.connectionManagerService.forceRestartConnection(instrument);
  }

  dismissUpdate() {
    if (this.availableUpdate) {
      this.updateCheckService.dismiss(this.availableUpdate.version);
    }
  }

  openReleasesPage() {
    void this.updateCheckService.openReleasesPage();
  }

  deferInstalledUpdate() {
    this.installedUpdateDeferred = true;
  }

  /**
   * Restarts into the installed version once no analyzer is sending, so no
   * transmission is cut off. The wait is capped, as it is for the database
   * restart, because a connection stuck mid-transmission would hold it forever.
   */
  restartForInstalledUpdate() {
    if (this.restartingForUpdate) return;
    this.restartingForUpdate = true;
    let waitedSeconds = 0;
    const tryRestart = () => {
      this.restartWaitingFor = this.connectionManagerService.instrumentsReceiving();
      if (this.restartWaitingFor.length === 0 || waitedSeconds >= ConsoleComponent.MAX_RESTART_WAIT_SECONDS) {
        this.stopRestartWait();
        this.updateCheckService.restart().catch(err => {
          console.error('Could not restart to finish the update:', err);
          this.restartingForUpdate = false;
          this.cdRef.detectChanges();
        });
      }
      waitedSeconds++;
      this.cdRef.detectChanges();
    };
    tryRestart();
    if (this.restartingForUpdate && !this.restartWaitTimer && this.restartWaitingFor.length > 0) {
      this.restartWaitTimer = setInterval(tryRestart, 1000);
    }
  }

  private stopRestartWait() {
    if (this.restartWaitTimer) {
      clearInterval(this.restartWaitTimer);
      this.restartWaitTimer = null;
    }
  }

  ngOnDestroy() {
    this.viewDestroyed = true;
    this.visibleColumnsSubscription?.unsubscribe();
    this.updateSubscription?.unsubscribe();
    this.installedUpdateSubscription?.unsubscribe();
    this.stopRestartWait();
    document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
    if (this.initialResultsTimeout) {
      clearTimeout(this.initialResultsTimeout);
    }
    if (this.logRenderTimer) {
      clearTimeout(this.logRenderTimer);
      this.logRenderTimer = null;
    }
    // Clear intervals
    [
      this.recentResultsInterval,
      this.mysqlCheckInterval,
      this.walCheckpointInterval,
      this.limsSyncPullInterval
    ].forEach(interval => {
      if (interval) {
        clearInterval(interval);
      }
    });

    // Unsubscribe from all subscriptions
    [
      this.electronStoreSubscription,
      this.instrumentsSubscription,
      this.resultSavedSubscription,
      this.logSubscription,
      this.logClearSubscription,
      this.searchSubscription
    ].forEach(subscription => {
      if (subscription) {
        subscription.unsubscribe();
      }
    });
  }
}
