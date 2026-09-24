import { Component, OnInit, OnDestroy, ChangeDetectorRef, ViewChild, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { UtilitiesService } from '../../services/utilities.service';
import { ConnectionManagerService } from '../../services/connection-manager.service';
import { RawDataProcessorService, ReprocessingStatus } from '../../services/raw-data-processor.service';
import { DatabaseService } from '../../services/database.service';
import { RawDataFilter, RawDataStore } from '../../interfaces/raw-machine-data.interface';
import { MatPaginator, PageEvent } from '@angular/material/paginator';
import { MatTableDataSource } from '@angular/material/table';
import { SelectionModel } from '@angular/cdk/collections';
import { Subscription } from 'rxjs';

@Component({
  standalone: false,
  selector: 'app-raw-data',
  templateUrl: './raw-data.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./raw-data.component.scss']
})
export class RawDataComponent implements OnInit, OnDestroy {
  public displayedColumns: string[] = [
    'select',
    'machine',
    'added_on',
    'data',
    'actions'
  ];

  public availableInstruments = [];
  private instrumentsSubscription: Subscription;
  private reprocessingSubscription: Subscription;

  public isReprocessing = false;
  public reprocessingStatus: ReprocessingStatus = {
    inProgress: false,
    processedCount: 0,
    totalCount: 0,
    currentItem: '',
    success: 0,
    empty: 0,
    failed: 0,
    errors: [],
    saved: 0,
    unchanged: 0,
    cancelled: false,
    stoppedBy: null
  };

  /** The filter being edited; `applied` is the one the list shows. */
  public filter: RawDataFilter = { instrumentId: '', from: '', to: '', search: '' };
  public applied: RawDataFilter = {};
  public instrumentNames: string[] = [];
  public store: RawDataStore = 'sqlite';
  public total = 0;
  public pageSize = 50;
  public pageIndex = 0;
  public loading = false;
  public loadError = '';

  private processingStartTime: number;

  selection = new SelectionModel<any>(true, []);

  dataSource = new MatTableDataSource<any>();
  @ViewChild(MatPaginator, { static: true }) paginator: MatPaginator;

  constructor(
    private utilitiesService: UtilitiesService,
    private connectionManagerService: ConnectionManagerService,
    private rawDataProcessor: RawDataProcessorService,
    private databaseService: DatabaseService,
    private cdRef: ChangeDetectorRef,
    private router: Router
  ) { }

  ngOnInit() {
    void this.loadPage();

    this.instrumentsSubscription = this.connectionManagerService.getActiveInstruments()
      .subscribe(instruments => {
        this.availableInstruments = instruments;
        this.cdRef.detectChanges();
      });

    this.reprocessingSubscription = this.rawDataProcessor.getReprocessingStatus()
      .subscribe(status => {
        this.reprocessingStatus = status;
        this.isReprocessing = status.inProgress;
        this.cdRef.detectChanges();
      });
  }

  /** True when the filter picks out a subset rather than everything. */
  get isFiltered(): boolean {
    return !!(this.applied.instrumentId || this.applied.from || this.applied.to || this.applied.search);
  }

  get invalidRange(): boolean {
    return !!(this.filter.from && this.filter.to && this.filter.from > this.filter.to);
  }

  applyFilter(): void {
    if (this.invalidRange) {
      return;
    }
    this.applied = {
      instrumentId: this.filter.instrumentId || undefined,
      from: this.filter.from || undefined,
      to: this.filter.to || undefined,
      search: (this.filter.search ?? '').trim() || undefined
    };
    this.pageIndex = 0;
    this.selection.clear();
    void this.loadPage();
  }

  clearFilter(): void {
    this.filter = { instrumentId: '', from: '', to: '', search: '' };
    this.applyFilter();
  }

  onPage(event: PageEvent): void {
    this.pageIndex = event.pageIndex;
    this.pageSize = event.pageSize;
    this.selection.clear();
    void this.loadPage();
  }

  async loadPage(): Promise<void> {
    this.loading = true;
    this.loadError = '';
    this.cdRef.detectChanges();
    try {
      const page = await this.databaseService.listRawData(this.applied, this.pageSize, this.pageIndex * this.pageSize);
      this.store = page.store;
      this.total = page.total;
      this.dataSource.data = page.rows.map(row => ({ ...row, expanded: false }));
      this.instrumentNames = await this.databaseService.listRawDataInstruments(page.store);
    } catch (error) {
      console.error('Error fetching raw data:', error);
      this.loadError = 'Raw data could not be read.';
      this.utilitiesService.logger('error', 'Failed to fetch raw data ' + (error?.message ?? error), null);
      this.dataSource.data = [];
      this.total = 0;
    } finally {
      this.loading = false;
      this.cdRef.detectChanges();
    }
  }

  /** Whether the number of selected elements matches the number of rows on the page. */
  isAllSelected() {
    const numSelected = this.selection.selected.length;
    const numRows = this.dataSource.data.length;
    return numSelected === numRows && numRows > 0;
  }

  /** Selects all rows on the page if they are not all selected; otherwise clears the selection. */
  masterToggle() {
    if (this.isAllSelected()) {
      this.selection.clear();
    } else {
      this.dataSource.data.forEach(row => this.selection.select(row));
    }
  }

  checkboxLabel(row?: any): string {
    if (!row) {
      return `${this.isAllSelected() ? 'select' : 'deselect'} all`;
    }
    return `${this.selection.isSelected(row) ? 'deselect' : 'select'} row ${row.id}`;
  }

  click() {
    this.router.navigate(['/console']);
  }

  toggleRow(row: any, event?: MouseEvent) {
    if (event) {
      event.stopPropagation();
    }
    row.expanded = !row.expanded;
  }

  selectRow(row: any, event: MouseEvent) {
    const target = event.target as HTMLElement;
    const isActionButton = target.closest('.btn-expand-toggle') ||
      target.closest('.action-btn') ||
      target.closest('mat-checkbox');

    if (!isActionButton) {
      this.selection.toggle(row);
    }
  }

  reprocessSingleRow(row: any, event?: Event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (this.isReprocessing) {
      this.showMessage('Already processing data. Please wait until it completes.');
      return;
    }
    this.selection.clear();
    this.selection.select(row);
    void this.reprocessSelected();
  }

  async reprocessSelected() {
    if (this.isReprocessing) {
      this.showMessage('Already processing data. Please wait until it completes.');
      return;
    }

    const selected = [...this.selection.selected].sort((a, b) => Number(a.id) - Number(b.id));
    if (selected.length === 0) {
      this.showMessage('Please select rows to reprocess');
      return;
    }
    if (selected.length > 5 && !confirm(`Reprocess ${selected.length} transmissions?\n\n${RawDataComponent.REPROCESS_EXPLANATION}`)) {
      return;
    }

    await this.run(`${selected.length} selected raw data entries`, () => this.rawDataProcessor.reprocessRawData(selected));
    this.selection.clear();
  }

  /** Reprocesses every transmission the current filter matches, not only the page shown. */
  async reprocessAllMatching() {
    if (this.isReprocessing || this.total === 0) {
      return;
    }
    const scope = this.describeFilter(this.applied);
    if (!confirm(`Reprocess ${this.total.toLocaleString()} transmissions (${scope})?\n\n${RawDataComponent.REPROCESS_EXPLANATION}\n\nYou can stop it at any time.`)) {
      return;
    }
    const filter = { ...this.applied };
    const store = this.store;
    await this.run(`${this.total} raw data entries (${scope})`, () => this.rawDataProcessor.reprocessMatching(store, filter));
  }

  cancelReprocessing(): void {
    this.rawDataProcessor.cancel();
  }

  private static readonly REPROCESS_EXPLANATION =
    'Reprocessing reads each transmission again with the current settings. ' +
    'It does not store or send again a result that is already stored exactly as read. ' +
    'It stores a changed result as a new result and sends it to the LIS. ' +
    'If the sample already had a result for the same test, it marks the new result as a repeat.';

  private describeFilter(filter: RawDataFilter): string {
    const parts: string[] = [];
    parts.push(filter.instrumentId ? filter.instrumentId : 'every instrument');
    if (filter.from || filter.to) {
      parts.push(`${filter.from || 'the start'} to ${filter.to || 'today'}`);
    }
    if (filter.search) {
      parts.push(`containing "${filter.search}"`);
    }
    return parts.join(', ');
  }

  private async run(description: string, work: () => Promise<ReprocessingStatus>): Promise<void> {
    this.processingStartTime = Date.now();
    this.utilitiesService.logger('info', `Starting reprocessing of ${description}`, null);
    try {
      const result = await work();
      this.reportResult(result, this.formatProcessingTime(Date.now() - this.processingStartTime));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.utilitiesService.logger('error', `Error during reprocessing: ${errorMessage}`, null);
      this.showMessage(`Error during reprocessing: ${errorMessage}`);
    } finally {
      this.isReprocessing = false;
      this.cdRef.detectChanges();
      void this.loadPage();
    }
  }

  private reportResult(status: ReprocessingStatus, processingTime: string): void {
    const outcome = status.stoppedBy
      ? `Reprocessing stopped after ${status.processedCount} of ${status.totalCount} transmissions. ${status.stoppedBy}. The rest were not reprocessed.`
      : status.cancelled
        ? `Reprocessing stopped after ${status.processedCount} of ${status.totalCount} transmissions.`
        : `Reprocessing complete: ${status.processedCount} transmissions in ${processingTime}.`;
    this.showMessage(
      `${outcome}\n\n` +
      `New results stored: ${status.saved}\n` +
      `Already stored, not stored again: ${status.unchanged}\n` +
      `Transmissions with no results in them: ${status.empty}\n` +
      `Transmissions that could not be fully read: ${status.failed}`
    );

    if (status.stoppedBy) {
      this.utilitiesService.logger('error',
        `Reprocessing stopped after ${status.processedCount} of ${status.totalCount} transmissions: ${status.stoppedBy}`, null);
    }
    if (status.failed > 0 || status.stoppedBy) {
      if (status.failed > 0) {
        this.utilitiesService.logger('warn', `Reprocessing completed with ${status.failed} failures.`, null);
      }
      status.errors.forEach((error, index) => {
        this.utilitiesService.logger('error', `Error ${index + 1}: ${error}`, null);
      });
    } else {
      this.utilitiesService.logger('success',
        `Reprocessed ${status.processedCount} transmissions in ${processingTime}: ${status.saved} new results, ` +
        `${status.unchanged} already stored, ${status.empty} transmissions with no results`,
        null);
    }
  }

  showMessage(message: string) {
    alert(message);
  }

  formatProcessingTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes === 0) {
      return `${seconds} seconds`;
    }

    return `${minutes} min ${remainingSeconds} sec`;
  }

  ngOnDestroy() {
    [
      this.instrumentsSubscription,
      this.reprocessingSubscription
    ].forEach(subscription => subscription?.unsubscribe());
  }
}
