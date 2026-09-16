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
import { fromEvent, Subscription } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { debounceTime, distinctUntilChanged, map } from 'rxjs/operators';
import { LogDisplayService, LogEntry } from '../../services/log-display.service';
import { BACKGROUND_INTERVAL_MS } from '../../constants/domain.constants';

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
  private logRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private viewDestroyed = false;
  searchTerm: string = '';
  private pickedInitialTab = false; // run-once guard
  public commonSettings = null;
  public instrumentsSettings = null;
  public appVersion: string = null;
  /** The newer release to mention, or null when there is nothing to say. */
  public availableUpdate: { version: string } | null = null;
  public lastLimsSync = '';
  public lastResultReceived = '';
  public recentResultsInterval: any; // Interval for fetching recent results
  public mysqlCheckInterval: any; // Interval for checking MySQL connection
  public mysqlConnected: boolean = false;  // To store the MySQL connection status
  public walCheckpointInterval: any; // Interval for performing SQLite WAL checkpoints
  public limsSyncPullInterval: any; // Interval for pulling LIMS sync status updates from MySQL
  public data: any;
  public lastOrders: any;
  public showScrollToTop = false;
  private readonly ipc: any;
  private updateSubscription: Subscription | null = null;
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
    'test_unit',
    'test_type',
    'tested_by',
    'analysed_date_time',
    'added_on',
    'lims_sync_status',
    'lims_sync_date_time'
  ];
  /**
   * The columns actually shown: Notes only when a result on screen has one,
   * so an empty column does not push the sync status off the screen.
   */
  public visibleColumns: string[] = this.displayedColumns.filter(column => column !== 'notes');
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
    const that = this;
    if (row === null) {
      if (event.checked) {
        that.dataSource.data.forEach(row => that.selection.select(row));
      } else {
        that.selection.clear();
      }
    } else {
      that.selection.toggle(row);
    }
  }

  onChange(typeValue: number) {
    this.displayType = typeValue;
    this.selection.clear();
  }

  ngAfterViewInit() {
    // Setup debounced search after view is initialized and input element is available
    if (this.searchInput && this.searchInput.nativeElement) {
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
    const that = this;
    that.visibleColumnsSubscription = that.dataSource.connect().subscribe(rows => {
      const hasNotes = rows.some(row => typeof row?.notes === 'string' && row.notes.trim() !== '');
      const columns = that.displayedColumns.filter(column => hasNotes || column !== 'notes');
      if (columns.length !== that.visibleColumns.length) {
        that.visibleColumns = columns;
      }
    });
    that.loadSettings();
    that.checkMysqlConnection();

    that.updateSubscription = that.updateCheckService.availableUpdate().subscribe(update => {
      that.availableUpdate = update;
      that.cdRef.detectChanges();
    });
    that.updateCheckService.start();

    // Scroll to the top of the page when the component initializes
    window.scrollTo(0, 0);

    document.addEventListener('visibilitychange', this.visibilityChangeHandler);

    // Subscribe to available instruments from the connection manager
    that.instrumentsSubscription = that.connectionManagerService.getActiveInstruments()
      .subscribe(instruments => {
        that._ngZone.run(() => {
          that.availableInstruments = instruments;

          // pick first connected tab once (or first item if none connected)
          if (!that.pickedInitialTab && that.availableInstruments?.length) {
            const idx = that.availableInstruments.findIndex(i => i?.isConnected === true);
            if (idx >= 0) {
              that.selectTab(idx);
              that.pickedInitialTab = true;
            } else if (that.selectedTabIndex >= that.availableInstruments.length) {
              // still ensure a valid tab if array changed
              that.selectTab(0);
            }
          }


          // Check if we should auto-reconnect instruments
          that.checkForAutoReconnect();

          // Load persisted logs only once per instrument. Re-loading on every
          // status tick can overwrite in-memory live HL7 logs before they persist.
          that.loadRecentLogsForNewInstruments(instruments);
          that.cdRef.detectChanges();
        });
      });

    // Fetch last few orders on load
    this.initialResultsTimeout = setTimeout(() => {
      that.fetchRecentResults();
    }, 600);

    // Refresh recent results when new samples are saved
    that.resultSavedSubscription = that.instrumentInterfaceService.resultSaved$
      .pipe(debounceTime(250))
      .subscribe(() => {
        that._ngZone.run(() => {
          that.refreshRecentResultsAfterSave();
        });
      });

    // Check MySQL connection on regular intervals
    that.mysqlCheckInterval = setInterval(() => {
      that.checkMysqlConnection();
    }, BACKGROUND_INTERVAL_MS.MYSQL_HEALTH);

    // Background refresh + MySQL resync every 5 minutes. New results trigger
    // an immediate refresh via resultSaved$, and the user can hit the refresh
    // button — this tick is just a safety net for idle periods.
    that.recentResultsInterval = setInterval(() => {
      that.fetchRecentResults();
      that.resyncTestResultsToMySQL();
      that.resyncTelemetryToMySQL();
      that.resyncIntelisStatusesToMySQL();
    }, BACKGROUND_INTERVAL_MS.RESULT_REFRESH);

    // Pull LIMS sync status from MySQL into SQLite every 30s. Any external
    // LIS integration (PHP, Python, Node, anything that can talk to MySQL)
    // writes lims_sync_status + lims_sync_date_time to the shared MySQL
    // orders table; this watermark sync surfaces those updates in the
    // console UI quickly. Cost when idle: two small indexed queries.
    that.limsSyncPullInterval = setInterval(() => {
      if (that.mysqlConnected) {
        that.utilitiesService.syncLimsStatusToSQLite(
          (result) => that._refreshOrdersDisplayAfterLimsPull(result),
          () => { }
        );
      }
    }, BACKGROUND_INTERVAL_MS.LIMS_STATUS_PULL);

    // SQLite WAL checkpoint every 30 minutes
    that.walCheckpointInterval = setInterval(() => {
      that.runSQLiteWalCheckpoint();
    }, BACKGROUND_INTERVAL_MS.WAL_CHECKPOINT);

    // Subscribe to logs from the display service
    that.logSubscription = that.logDisplayService.log$.subscribe(logEntry => {
      that._ngZone.run(() => {
        that.updateLogUI(logEntry);
      });
    });

    // Subscribe to clear events
    that.logClearSubscription = that.logDisplayService.clear$.subscribe(instrumentId => {
      that._ngZone.run(() => {
        if (instrumentId) {
          // Clear logs for a specific instrument
          if (that.instrumentLogs[instrumentId]) {
            that.instrumentLogs[instrumentId].logs = [];
            that.instrumentLogs[instrumentId].filteredLogs = [];
          }
        } else {
          // Clear all logs if no ID is specified
          Object.keys(that.instrumentLogs).forEach(id => {
            that.instrumentLogs[id].logs = [];
            that.instrumentLogs[id].filteredLogs = [];
          });
        }
        that.cdRef.detectChanges();
      });
    });

    that.loadRecentSystemLogs();
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
            document.body.removeChild(notification);
          }, 3000);
        }
      }, 1000); // Wait 1 second after component initialization
    }
  }

  loadSettings() {
    const that = this;
    that.electronStoreSubscription = that.store.electronStoreObservable().subscribe(electronStoreObject => {
      that._ngZone.run(() => {
        that.commonSettings = electronStoreObject.commonConfig;
        that.instrumentsSettings = electronStoreObject.instrumentsConfig;
        that.appVersion = electronStoreObject.appVersion;
        that.cdRef.detectChanges();
      });
    });
  }

  reSyncSelectedRecords() {
    const that = this;
    that.selection.selected.forEach(selectedRow => {
      if (that.utilitiesService) {
        that.utilitiesService.reSyncRecord(selectedRow.order_id).subscribe({
          next: () => {
            selectedRow.lims_sync_status = '0';
            that.dataSource.data = [...that.dataSource.data];
            // Clear selection after re-sync
            that.selection.clear();
          },
          error: (error) => {
            console.error('Error during re-sync:', error);
          }
        });
      } else {
        console.error('Utilities service is undefined.');
      }
    });
  }

  fetchRecentResults(searchTerm?: string) {
    const that = this;
    const trimmedTerm = (searchTerm || '').trim();

    // Only sync when NOT searching (i.e., when getting all results)
    if (trimmedTerm === '') {
      console.log('Fetching all results with sync');
      that.resyncTestResultsToMySQL();
    } else {
      console.log('Fetching search results without sync');
    }

    that.utilitiesService.fetchRecentResults(trimmedTerm).subscribe({
      next: lastFewOrders => {
        that._ngZone.run(() => {
          that.lastOrders = lastFewOrders;
          that.data = lastFewOrders;
          that.dataSource.data = that.lastOrders;
          that.dataSource.paginator = that.paginator;
          that.dataSource.sort = that.sort;

          that.sort.active = 'added_on';
          that.sort.direction = 'desc';
          that.sort.sortChange.emit({ active: that.sort.active, direction: that.sort.direction });

          that.cdRef.detectChanges();
        });
      },
      error: error => {
        console.error('Error fetching last orders:', error);
      }
    });

    that.utilitiesService.fetchLastSyncTimes().subscribe({
      next: (data) => {
        that.lastLimsSync = that.utilitiesService.humanReadableDateTime(data.lastLimsSync);
        that.lastResultReceived = that.utilitiesService.humanReadableDateTime(data.lastResultReceived);
      },
      error: (err) => console.error('Error fetching last sync times:', err)
    });
  }

  clearSearch() {
    console.log('Clearing search');
    this.searchTerm = '';
    if (this.searchInput && this.searchInput.nativeElement) {
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
    const that = this;
    const trimmedTerm = (searchTerm || '').trim();

    console.log('Searching with trimmed term:', `"${trimmedTerm}"`);

    // Pass the trimmed term to the service
    that.utilitiesService.fetchRecentResults(trimmedTerm).subscribe({
      next: (results) => {
        that._ngZone.run(() => {
          that.lastOrders = results;
          that.data = results;
          that.dataSource.data = that.lastOrders;
          that.dataSource.paginator = that.paginator;
          that.dataSource.sort = that.sort;

          that.sort.active = 'added_on';
          that.sort.direction = 'desc';
          that.sort.sortChange.emit({ active: that.sort.active, direction: that.sort.direction });

          that.cdRef.detectChanges();

          console.log(`Search completed: ${that.lastOrders?.length || 0} results for "${trimmedTerm}"`);
        });
      },
      error: (error) => console.error('Error fetching search results:', error)
    });
  }

  /**
   * Refresh method - Syncs AND fetches all results
   */
  refreshResults() {
    const that = this;
    console.log('Refreshing all results with sync');

    // Do the sync first, then fetch all results
    that.resyncTestResultsToMySQL();
    that.utilitiesService.fetchRecentResults('').subscribe({
      next: (results) => {
        that._ngZone.run(() => {
          that.lastOrders = results;
          that.data = results;
          that.dataSource.data = that.lastOrders;
          that.dataSource.paginator = that.paginator;
          that.dataSource.sort = that.sort;

          that.sort.active = 'added_on';
          that.sort.direction = 'desc';
          that.sort.sortChange.emit({ active: that.sort.active, direction: that.sort.direction });

          that.cdRef.detectChanges();
        });
      },
      error: (error) => console.error('Error fetching refreshed results:', error)
    });

    that.utilitiesService.fetchLastSyncTimes().subscribe({
      next: (data) => {
        that.lastLimsSync = that.utilitiesService.humanReadableDateTime(data.lastLimsSync);
        that.lastResultReceived = that.utilitiesService.humanReadableDateTime(data.lastResultReceived);
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

  toggleSystemLogs(): void {
    this.systemLogsExpanded = !this.systemLogsExpanded;
  }

  private loadRecentLogsForNewInstruments(instruments: any[]) {
    const that = this;
    instruments.forEach(instrument => {
      const instrumentId = instrument?.connectionParams?.instrumentId;
      if (!instrumentId || that.loadedLogInstrumentIds.has(instrumentId)) {
        return;
      }

      that.loadedLogInstrumentIds.add(instrumentId);
      that.utilitiesService.fetchRecentLogs(instrumentId)
        .subscribe(logs => {
          that._ngZone.run(() => {
            that.updateLogsForInstrument(instrumentId, logs);
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
    const that = this;
    if (!that.instrumentLogs[instrument.connectionParams.instrumentId]) {
      // Initialize the logs structure for the instrument if not already done
      that.instrumentLogs[instrument.connectionParams.instrumentId] = {
        logs: [],
        filteredLogs: []
      };
    }

    const bucket = that.instrumentLogs[instrument.connectionParams.instrumentId];
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

    that.cdRef.detectChanges(); // Trigger change detection if needed
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

  clearLiveLog(instrument: any) {
    const instrumentId = instrument.connectionParams.instrumentId;
    // This will trigger the subscription to clear the UI
    this.logDisplayService.clearLogs(instrumentId);
    this._ngZone.run(() => {
      this.snackBar.open('Logs cleared', undefined, {
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
    const that = this;
    const commonSettings = that.store.get('commonConfig');
    const mysqlParams = {
      host: commonSettings.mysqlHost,
      user: commonSettings.mysqlUser,
      password: commonSettings.mysqlPassword,
      port: commonSettings.mysqlPort
    };

    that.utilitiesService.checkMysqlConnection(
      mysqlParams,
      () => {
        that.mysqlConnected = true;
        that.cdRef.detectChanges();
      },
      (err) => {
        that.mysqlConnected = false;
        that.cdRef.detectChanges();
      }
    );
  }

  runSQLiteWalCheckpoint(): void {
    const that = this;
    that.utilitiesService.sqlite3WalCheckpoint();
    that.utilitiesService.logger('info', 'SQLite WAL checkpoint scheduled and executed', null);
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

  ngOnDestroy() {
    this.viewDestroyed = true;
    this.visibleColumnsSubscription?.unsubscribe();
    this.updateSubscription?.unsubscribe();
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
