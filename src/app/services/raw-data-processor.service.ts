import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronStoreService } from './electron-store.service';
import { UtilitiesService } from './utilities.service';
import { InstrumentInterfaceService, ResultSaveOptions, ResultSaveStats } from './instrument-interface.service';
import { InstrumentConnectionStack } from '../interfaces/instrument-connections.interface';
import { RawDataFilter, RawDataStore } from '../interfaces/raw-machine-data.interface';
import { effectiveResultRules } from '../../../shared/result-rules';

type ReprocessOutcome = 'stored' | 'empty' | 'failed';

export interface ReprocessingStatus {
  inProgress: boolean;
  processedCount: number;
  totalCount: number;
  currentItem: string;
  /** Transmissions every result of which was stored or already stored */
  success: number;
  /**
   * Transmissions with no result records at all, such as an analyzer asking
   * the LIS for a sample's orders. Nothing to read, and nothing wrong.
   */
  empty: number;
  /** Transmissions with result records that did not all yield a stored result */
  failed: number;
  errors: string[];
  /** Results stored as new rows */
  saved: number;
  /** Results already stored exactly as read, so not stored again */
  unchanged: number;
  cancelled: boolean;
  /**
   * Why the run stopped before the end of its range, when the raw data could
   * not be read. The transmissions after it were not reprocessed.
   */
  stoppedBy: string | null;
}

/** What compacting one database did. */
export interface CompactionReport {
  store: RawDataStore;
  transmissions: number;
  /** Transmissions not read because no instrument in Settings has their name */
  skippedTransmissions: number;
  /** Results now carrying the identifier of their transmission */
  linkedResults: number;
  /** Of those, results whose raw text was cut to their own records */
  trimmedResults: number;
  /** Characters of raw text removed from results */
  charactersRemoved: number;
  cancelled: boolean;
}

export interface CompactionProgress {
  store: RawDataStore;
  transmissionsRead: number;
  totalTransmissions: number;
  linkedResults: number;
  trimmedResults: number;
}

@Injectable({
  providedIn: 'root'
})
export class RawDataProcessorService {
  private static readonly PERSISTENCE_TIMEOUT_MS = 60_000;
  private static readonly BATCH_SIZE = 20;
  // Results are stored after the transmission they came from, and the two
  // are stamped by separate writes that can wait on MySQL; a result can
  // even be stamped first. Rows this much older than a transmission are
  // not linked to it.
  private static readonly LINK_CLOCK_SKEW_SECONDS = 5 * 60;

  // Compacting starts this long after the application does, so it never
  // competes with connecting to instruments and the first results.
  private static readonly AUTOMATIC_COMPACTION_DELAY_MS = 2 * 60_000;
  private static readonly COMPACTED_STORES_KEY = 'storageCompacted';

  private reprocessingStatus = new BehaviorSubject<ReprocessingStatus>(RawDataProcessorService.idleStatus());
  private cancelRequested = false;
  /** The compaction running in the background, if any. */
  private backgroundRun: Promise<void> | null = null;
  private backgroundStopRequested = false;
  private readonly backgroundCompaction = new BehaviorSubject<CompactionProgress | null>(null);
  /** Progress of the compaction running in the background, or null. */
  public readonly backgroundCompaction$ = this.backgroundCompaction.asObservable();

  private instrumentsSettings: any = null;
  private commonSettings: any = null;

  constructor(
    private utilsService: UtilitiesService,
    private readonly electronStoreService: ElectronStoreService,
    private instrumentInterfaceService: InstrumentInterfaceService
  ) {
    this.commonSettings = this.electronStoreService.get('commonConfig');
    this.instrumentsSettings = this.electronStoreService.get('instrumentsConfig');
  }

  private static idleStatus(): ReprocessingStatus {
    return {
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
  }

  getReprocessingStatus(): Observable<ReprocessingStatus> {
    return this.reprocessingStatus.asObservable();
  }

  /**
   * Compacts, once, the results stored before 4.8.0, in the background a
   * little after the application starts. It links and trims exactly as
   * Compact Storage does, and does not rewrite the database: freed space is
   * reused inside it. A database compacted to the end is recorded and never
   * walked again; one that was stopped is compacted again next time.
   */
  scheduleAutomaticCompaction(delayMs = RawDataProcessorService.AUTOMATIC_COMPACTION_DELAY_MS): void {
    setTimeout(() => {
      this.backgroundStopRequested = false;
      this.backgroundRun = this.compactAutomatically().finally(() => {
        this.backgroundRun = null;
        this.backgroundCompaction.next(null);
      });
    }, delayMs);
  }

  /** Stops the background compaction, if one is running, and waits for it. */
  async stopBackgroundCompaction(): Promise<void> {
    if (!this.backgroundRun) {
      return;
    }
    this.backgroundStopRequested = true;
    await this.backgroundRun;
  }

  private async compactAutomatically(): Promise<void> {
    if (this.reprocessingStatus.value.inProgress) {
      return;
    }
    const dbService = this.instrumentInterfaceService.dbService;
    const stores: RawDataStore[] = (await dbService.rawDataStore()) === 'mysql' ? ['sqlite', 'mysql'] : ['sqlite'];
    for (const store of stores) {
      if (this.backgroundStopRequested) {
        return;
      }
      if (this.isCompacted(store)) {
        continue;
      }
      try {
        // A database with no result left to link has nothing to compact.
        if (await dbService.countUnlinkedResults(store) > 0) {
          const report = await this.runCompaction(store, progress => this.backgroundCompaction.next(progress), () => this.backgroundStopRequested);
          if (report.cancelled) {
            return;
          }
          this.utilsService.logger('info',
            `Storage compacted (${store === 'mysql' ? 'MySQL' : 'this computer'}): ${report.linkedResults} results linked, ` +
            `${report.trimmedResults} cut to their own records.`, null);
        }
        this.markCompacted(store);
      } catch (error) {
        // It is tried again at the next start. What it did stays done.
        this.utilsService.logger('error', `Storage compaction stopped: ${error instanceof Error ? error.message : error}`, null);
        return;
      }
    }
  }

  private isCompacted(store: RawDataStore): boolean {
    return !!(this.electronStoreService.get(RawDataProcessorService.COMPACTED_STORES_KEY) ?? {})[this.compactedStoreKey(store)];
  }

  private markCompacted(store: RawDataStore): void {
    const compacted = this.electronStoreService.get(RawDataProcessorService.COMPACTED_STORES_KEY) ?? {};
    this.electronStoreService.set(RawDataProcessorService.COMPACTED_STORES_KEY, { ...compacted, [this.compactedStoreKey(store)]: new Date().toISOString() });
  }

  /** One record per database: MySQL by server and database, as either can change. */
  private compactedStoreKey(store: RawDataStore): string {
    if (store === 'sqlite') {
      return 'sqlite';
    }
    const settings = this.electronStoreService.get('commonConfig') ?? {};
    return `mysql:${settings.mysqlHost ?? ''}:${settings.mysqlPort ?? ''}/${settings.mysqlDb ?? ''}`;
  }

  /** Stops a running reprocess or compaction after the transmission in hand. */
  cancel(): void {
    this.cancelRequested = true;
    this.backgroundStopRequested = true;
  }

  /** Reprocesses the given stored transmissions, in the order given. */
  async reprocessRawData(rawDataEntries: any[]): Promise<ReprocessingStatus> {
    if (!rawDataEntries || rawDataEntries.length === 0) {
      return RawDataProcessorService.idleStatus();
    }
    const entries = [...rawDataEntries];
    return this.runReprocessing(entries.length, async () => entries.splice(0, RawDataProcessorService.BATCH_SIZE));
  }

  /**
   * Reprocesses every stored transmission that matches the filter, oldest
   * first, reading them a batch at a time so a long range never has to fit
   * in memory. Transmissions that arrive while it runs are not included.
   */
  async reprocessMatching(store: RawDataStore, filter: RawDataFilter): Promise<ReprocessingStatus> {
    const dbService = this.instrumentInterfaceService.dbService;
    const total = await dbService.countRawData(store, filter);
    if (total === 0) {
      return RawDataProcessorService.idleStatus();
    }
    // The newest matching row when the run starts bounds it.
    const [newest] = await dbService.nextRawDataBatch(store, filter, Number.MAX_SAFE_INTEGER, 1, 'desc');
    const lastId = Number(newest?.id ?? 0);
    let afterId = 0;
    return this.runReprocessing(total, async () => {
      const batch = (await dbService.nextRawDataBatch(store, filter, afterId, RawDataProcessorService.BATCH_SIZE))
        .filter(entry => Number(entry.id) <= lastId);
      if (batch.length > 0) {
        afterId = Number(batch[batch.length - 1].id);
      }
      return batch;
    });
  }

  private async runReprocessing(totalCount: number, nextBatch: () => Promise<any[]>): Promise<ReprocessingStatus> {
    // Reprocessing and compacting share the Stop request, so one at a time.
    await this.stopBackgroundCompaction();
    this.cancelRequested = false;
    const stats: ResultSaveStats = { saved: 0, unchanged: 0 };
    const status: ReprocessingStatus = {
      ...RawDataProcessorService.idleStatus(),
      inProgress: true,
      totalCount,
      currentItem: 'Starting reprocessing...'
    };
    const publish = () => this.reprocessingStatus.next({ ...status, ...stats, errors: [...status.errors] });
    publish();

    // Settings can change while the application runs (an instrument renamed,
    // its rules edited): reprocess with them as they are now.
    this.instrumentsSettings = this.electronStoreService.get('instrumentsConfig');

    try {
      for (let batch = await nextBatch(); batch.length > 0 && !this.cancelRequested; batch = await nextBatch()) {
        for (const entry of batch) {
          if (this.cancelRequested) {
            break;
          }
          status.currentItem = `Processing ${status.processedCount + 1}/${totalCount} (${entry.instrument_id || entry.machine})`;
          publish();

          try {
            const outcome = await this.reprocessEntry(entry, stats);
            if (outcome === 'stored') {
              status.success++;
            } else if (outcome === 'empty') {
              status.empty++;
            } else {
              status.failed++;
              status.errors.push(`Failed to reprocess raw data ID: ${entry.id}`);
            }
          } catch (error) {
            status.failed++;
            status.errors.push(`Error processing raw data ID ${entry.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          status.processedCount++;
          publish();
        }
      }
    } catch (error) {
      // A batch that cannot be read ends the run. What was done is reported,
      // and so is the stop: the rest of the range was not reprocessed.
      status.stoppedBy = `Could not read raw data: ${error instanceof Error ? error.message : 'Unknown error'}`;
      status.errors.push(status.stoppedBy);
    }

    status.inProgress = false;
    status.cancelled = this.cancelRequested;
    status.currentItem = status.cancelled || status.stoppedBy ? 'Reprocessing stopped' : 'Reprocessing complete';
    this.cancelRequested = false;
    publish();
    return { ...status, ...stats };
  }

  private getInstrumentSettings(analyzerMachineName: string): any {
    if (!Array.isArray(this.instrumentsSettings) || !analyzerMachineName) {
      return null;
    }

    const instrumentSettings = this.instrumentsSettings.find(
      (inst: any) =>
        inst.analyzerMachineName &&
        inst.analyzerMachineName.toLowerCase() === analyzerMachineName.toLowerCase()
    );

    if (instrumentSettings) {
      return instrumentSettings;
    }

    const flexMatch = this.instrumentsSettings.find(
      (inst: any) =>
        inst.analyzerMachineName &&
        (inst.analyzerMachineName.toLowerCase().includes(analyzerMachineName.toLowerCase()) ||
          analyzerMachineName.toLowerCase().includes(inst.analyzerMachineName.toLowerCase()))
    );

    if (flexMatch) {
      this.utilsService.logger('info', `Flexible match found for ${analyzerMachineName}`, analyzerMachineName);
      return flexMatch;
    }

    return null;
  }

  private connectionFor(instrumentSettings: any): InstrumentConnectionStack {
    const protocol = instrumentSettings.interfaceCommunicationProtocol;
    return {
      instrumentId: instrumentSettings.analyzerMachineName,
      machineType: instrumentSettings.analyzerMachineType,
      connectionProtocol: protocol,
      labName: instrumentSettings.labName || 'Default Lab',
      resultRules: effectiveResultRules(instrumentSettings, protocol),
      transmissionStatusSubject: new BehaviorSubject<boolean>(false),
      statusSubject: new BehaviorSubject<boolean>(true),
      connectionAttemptStatusSubject: new BehaviorSubject<boolean>(true),
      connectionSocket: null,
      connectionServer: null,
      errorOccurred: false,
      reconnectAttempts: 0
    };
  }

  private async reprocessEntry(entry: any, stats: ResultSaveStats): Promise<ReprocessOutcome> {
    const instrumentId = entry.instrument_id || entry.machine;
    const instrumentSettings = this.getInstrumentSettings(instrumentId);
    if (!instrumentSettings) {
      throw new Error(`No settings found for instrument: ${instrumentId}`);
    }

    // The results are linked to the transmission they are read from, which
    // is given an identifier now if it was stored before identifiers.
    const transmissionId = entry.store
      ? await this.instrumentInterfaceService.dbService.ensureTransmissionIdentity(entry)
      : entry.transmission_id ?? undefined;
    return this.reprocessUsingInstrumentInterface(entry, instrumentSettings, { transmissionId, skipIdentical: true, stats });
  }

  /**
   * `stored` when every result was stored or already stored, `empty` when the
   * transmission is certain to hold no result, `failed` otherwise. Empty is
   * narrow on purpose, because it hides nothing only when nothing is there:
   * an HL7 message with no OBX, SPM or OBR anywhere in it, or ASTM made only
   * of header, patient, query, comment, manufacturer and terminator records.
   * Anything else that yields no result is a failure, however it fails.
   */
  private async reprocessUsingInstrumentInterface(entry: any, instrumentSettings: any, options: ResultSaveOptions): Promise<ReprocessOutcome> {
    try {
      const rawData = entry.data;
      const protocol = instrumentSettings.interfaceCommunicationProtocol;
      const instrumentConnectionData = this.connectionFor(instrumentSettings);

      let persistenceResults: boolean[] = [];
      if (protocol === 'hl7') {
        // Raw data keeps the MLLP block exactly as it arrived. Unwrap it the
        // way live processing does, or framing bytes end up in the stored
        // records and line breaks are split differently.
        const hl7Message = this.instrumentInterfaceService['hl7Helper'].unwrapMLLPBlock(rawData);
        const unreadable = { count: 0 };
        persistenceResults = await this.withPersistenceTimeout(
          this.instrumentInterfaceService.processHL7Message(instrumentConnectionData, hl7Message, { ...options, unreadable })
        );
        // A specimen that could not be read is a result not recovered, as an
        // unreadable ASTM order is.
        if (unreadable.count > 0) {
          return 'failed';
        }
        if (persistenceResults.length === 0 && RawDataProcessorService.isHL7WithoutResults(hl7Message)) {
          return 'empty';
        }
      } else if (protocol === 'astm-checksum' || protocol === 'astm-nonchecksum') {
        const astmData = this.utilsService.removeControlCharacters(rawData, protocol !== 'astm-nonchecksum');
        if (this.instrumentInterfaceService['astmHelper'].isHL7Transmission(astmData)) {
          this.utilsService.logger('error', `Raw data ID ${entry.id} holds HL7, but this instrument is set to ASTM; nothing was read from it`, instrumentSettings.analyzerMachineName);
          return 'failed';
        }
        const parts = astmData.split(this.instrumentInterfaceService['astmHelper'].getStartMarker());
        const sampleResults: any[] = [];

        // The same extraction live processing uses, so a stored transmission
        // yields exactly the results it yielded when it arrived.
        const astmHelper = this.instrumentInterfaceService['astmHelper'];
        let unreadableOrders = 0;
        let hl7Messages = 0;
        let resultBearingRecords = 0;
        for (const part of parts) {
          if (!part) continue;
          resultBearingRecords += part.split(/<CR>/).filter(record => !RawDataProcessorService.isASTMRecordWithoutResults(record)).length;
          const extraction = astmHelper.extractASTMResults(part.split(/<CR>/), part);
          if (extraction.isHL7) {
            hl7Messages++;
            continue;
          }
          unreadableOrders += extraction.unreadableOrders;
          sampleResults.push(...extraction.results);
        }
        persistenceResults = await this.withPersistenceTimeout(
          this.instrumentInterfaceService.saveASTMResults(sampleResults, instrumentConnectionData, options)
        );
        // An order that could not be read is a result not recovered: the
        // entry has not been reprocessed, whatever else it yielded.
        if (unreadableOrders > 0) {
          return 'failed';
        }
        if (hl7Messages > 0) {
          this.utilsService.logger('error', `Raw data ID ${entry.id} holds HL7, but this instrument is set to ASTM; nothing was read from it`, instrumentSettings.analyzerMachineName);
          return 'failed';
        }
        if (resultBearingRecords === 0 && persistenceResults.length === 0) {
          return 'empty';
        }
      } else {
        throw new Error(`Unsupported protocol: ${protocol}`);
      }

      return persistenceResults.length > 0 && persistenceResults.every(Boolean) ? 'stored' : 'failed';
    } catch (error) {
      this.utilsService.logger('error', `InstrumentInterface reprocessing error: ${error}`, entry.instrument_id || entry.machine);
      return 'failed';
    }
  }

  /** An HL7 message, recognisably one, with no segment that can carry a result. */
  static isHL7WithoutResults(message: string): boolean {
    return /(^|\r)MSH\|/.test(message) && !/OBX|SPM|OBR/.test(message);
  }

  /**
   * An ASTM record that cannot carry a result: header, patient, query,
   * comment, manufacturer or terminator, behind its frame number if any, or
   * nothing at all. Every other record, including one not recognised, might.
   */
  static isASTMRecordWithoutResults(record: string): boolean {
    const text = (record ?? '').trim();
    return text === '' || /^\d*[HPQCML]\|/.test(text);
  }

  /**
   * The results in a stored transmission, read the way reprocessing reads
   * them but not saved, acknowledged, logged or counted, with the
   * transmission as the parser saw it once its framing was taken off.
   */
  readTransmission(entry: any, instrumentSettings: any): { results: any[]; unframed: string } {
    const protocol = instrumentSettings.interfaceCommunicationProtocol;
    const connection = this.connectionFor(instrumentSettings);
    if (protocol === 'hl7') {
      const hl7Message = this.instrumentInterfaceService['hl7Helper'].unwrapMLLPBlock(entry.data);
      return { results: this.instrumentInterfaceService.readHL7Results(connection, hl7Message, false), unframed: hl7Message };
    }
    const astmData = this.utilsService.removeControlCharacters(entry.data, protocol !== 'astm-nonchecksum');
    const astmHelper = this.instrumentInterfaceService['astmHelper'];
    if (astmHelper.isHL7Transmission(astmData)) {
      return { results: [], unframed: astmData };
    }
    const results: any[] = [];
    for (const part of astmData.split(astmHelper.getStartMarker())) {
      if (part) {
        results.push(...astmHelper.extractASTMResults(part.split(/<CR>/), part).results);
      }
    }
    return { results, unframed: astmData };
  }

  /**
   * Links stored results to the stored transmission they came from and cuts
   * each result's raw text down to the records it was read from.
   *
   * A result is changed only when its raw text is proven to be held in a
   * stored transmission: every record of it, framing aside, appears whole
   * and in order in that transmission. A result whose transmission is not stored keeps its
   * raw text whole. Transmissions themselves are never changed, apart from
   * being given an identifier and fingerprint if they have none.
   *
   * Transmissions are walked newest first, and a result is linked only to
   * one received no later than it was stored, so an analyzer sending the
   * same message again does not draw earlier results to the later copy.
   */
  async compactStorage(store: RawDataStore, onProgress: (progress: CompactionProgress) => void = () => {}): Promise<CompactionReport> {
    await this.stopBackgroundCompaction();
    this.cancelRequested = false;
    const report = await this.runCompaction(store, onProgress, () => this.cancelRequested);
    this.cancelRequested = false;
    if (!report.cancelled) {
      this.markCompacted(store);
    }
    return report;
  }

  private async runCompaction(
    store: RawDataStore,
    onProgress: (progress: CompactionProgress) => void,
    shouldStop: () => boolean
  ): Promise<CompactionReport> {
    const dbService = this.instrumentInterfaceService.dbService;
    this.instrumentsSettings = this.electronStoreService.get('instrumentsConfig');

    const report: CompactionReport = {
      store, transmissions: 0, skippedTransmissions: 0, linkedResults: 0, trimmedResults: 0, charactersRemoved: 0, cancelled: false
    };
    const totalTransmissions = await dbService.countRawData(store, {});
    let beforeId = Number.MAX_SAFE_INTEGER;

    while (!shouldStop()) {
      const batch = await dbService.nextRawDataBatch(store, {}, beforeId, RawDataProcessorService.BATCH_SIZE, 'desc');
      if (batch.length === 0) {
        break;
      }
      beforeId = Number(batch[batch.length - 1].id);

      for (const entry of batch) {
        if (shouldStop()) {
          break;
        }
        report.transmissions++;
        await this.compactTransmission(store, entry, report);
        onProgress({
          store,
          transmissionsRead: report.transmissions,
          totalTransmissions,
          linkedResults: report.linkedResults,
          trimmedResults: report.trimmedResults
        });
      }
    }

    report.cancelled = shouldStop();
    return report;
  }

  private async compactTransmission(store: RawDataStore, entry: any, report: CompactionReport): Promise<void> {
    const dbService = this.instrumentInterfaceService.dbService;
    const instrumentSettings = this.getInstrumentSettings(entry.instrument_id || entry.machine);
    if (!instrumentSettings) {
      report.skippedTransmissions++;
      return;
    }

    let read: { results: any[]; unframed: string };
    try {
      read = this.readTransmission(entry, instrumentSettings);
    } catch {
      // A transmission the parser cannot read proves nothing about any result.
      return;
    }
    if (read.results.length === 0) {
      return;
    }

    const transmissionId = await dbService.ensureTransmissionIdentity(entry);
    const heldText = [entry.data, read.unframed].map(text => `\n${RawDataProcessorService.recordsOf(text)}\n`);
    const notBefore = RawDataProcessorService.storedDateTimeMinus(entry.added_on, RawDataProcessorService.LINK_CLOCK_SKEW_SECONDS);

    const resultsByOrder = new Map<string, any[]>();
    for (const result of read.results) {
      const orderId = result.order_id ?? '';
      resultsByOrder.set(orderId, [...(resultsByOrder.get(orderId) ?? []), result]);
    }

    for (const [orderId, parsed] of resultsByOrder) {
      if (!orderId) {
        continue;
      }
      for (const row of await dbService.unlinkedResultsFor(store, orderId, notBefore)) {
        const rowText = String(row.raw_text ?? '');
        const records = RawDataProcessorService.recordsOf(rowText);
        if (!records || !heldText.some(text => text.includes(`\n${records}\n`))) {
          continue;
        }
        const ownRecords = RawDataProcessorService.ownRecords(parsed, row);
        const rawText = ownRecords && ownRecords.length < rowText.length ? ownRecords : rowText;
        if (await dbService.linkResultToTransmission(store, row.id, transmissionId, rawText, Number(row.raw_text_length))) {
          report.linkedResults++;
          if (rawText !== rowText) {
            report.trimmedResults++;
            report.charactersRemoved += rowText.length - rawText.length;
          }
        }
      }
    }
  }

  /**
   * The records a stored result was read from, as the parser reads them now:
   * the one result in the transmission for the same sample and test, or, when
   * the sample ran more than once, the one that also has the same value, and
   * then the same test identifier and time. Null when no single run is
   * certain, so a run never takes another run's records.
   */
  private static ownRecords(parsed: any[], row: any): string | null {
    const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');
    const narrowings: ((result: any) => boolean)[] = [
      result => same(result.test_type, row.test_type),
      result => same(result.results, row.results_as_sent ?? row.results),
      result => same(result.test_id, row.test_id) && same(result.analysed_date_time, row.analysed_date_time)
    ];
    let candidates = parsed;
    for (const narrowing of narrowings) {
      candidates = candidates.filter(narrowing);
      if (candidates.length <= 1) {
        break;
      }
    }
    const text = candidates.length === 1 ? candidates[0].raw_text : null;
    return typeof text === 'string' && text.length > 0 ? text : null;
  }

  /**
   * The records or segments in a text, one per line, with the framing around
   * them taken out: control characters and the <CR>-style markers the ASTM
   * reader writes for them, a frame's end and checksum (also where older
   * builds left the checksum as a line of its own), the start marker older
   * builds stored, and the frame number before a record. So a
   * result's raw text, as any build stored it, can be looked for whole
   * record by whole record in the transmission it came from.
   */
  static recordsOf(text: string): string {
    return String(text ?? '')
      .replace(/##START##/g, '\n')
      .replace(/(?:<ETX>|<ETB>|[\x03\x17])[0-9A-Fa-f]{0,2}/g, '\n')
      .replace(/<(?:CR|LF)>|[\r\n]/g, '\n')
      .replace(/<(?:STX|EOT|ENQ|ACK|NAK)>/g, '')
      .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
      .split('\n')
      .map(record => record.trim().replace(/^\d(?=[A-Z][A-Z0-9]{0,2}\|)/, ''))
      // A checksum older builds left behind as a line of its own
      .filter(record => record && !/^[0-9A-Fa-f]{1,2}$/.test(record))
      .join('\n');
  }

  /**
   * A stored date and time, minus some seconds, written back the way the
   * database stores it: "YYYY-MM-DD HH:MM:SS". MySQL hands DATETIME values
   * over as Dates in local time, SQLite as text.
   */
  static storedDateTimeMinus(value: unknown, seconds: number): string | null {
    const two = (n: number) => String(n).padStart(2, '0');
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const d = new Date(value.getTime() - seconds * 1000);
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value ?? ''));
    if (!match) {
      return null;
    }
    const [, year, month, day, hours, minutes, secs] = match.map(Number);
    const d = new Date(Date.UTC(year, month - 1, day, hours, minutes, secs) - seconds * 1000);
    return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  }

  private withPersistenceTimeout(persistence: Promise<boolean[]>): Promise<boolean[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for reprocessed results to be saved'));
      }, RawDataProcessorService.PERSISTENCE_TIMEOUT_MS);

      persistence.then(resolve, reject).finally(() => clearTimeout(timeout));
    });
  }
}
