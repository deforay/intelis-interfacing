import { Injectable } from '@angular/core';
import { DatabaseService } from './database.service';
import { InstrumentConnectionStack } from '../interfaces/instrument-connections.interface';
import { RawMachineData } from '../interfaces/raw-machine-data.interface';
import { UtilitiesService } from './utilities.service';
import { TcpConnectionService } from './tcp-connection.service';
import { HL7HelperService } from './hl7-helper.service';
import { ASTMHelperService } from './astm-helper.service';
import { ElectronStoreService } from './electron-store.service';
import { applyResultRules, effectiveResultRules, ResultRule } from '../../../shared/result-rules';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { COMMUNICATION_PROTOCOL, LIMS_SYNC_STATUS } from '../constants/domain.constants';
import { v4 as uuidv4 } from 'uuid';

/** Counts of what saving the results of a reprocessed transmission did. */
export interface ResultSaveStats {
  /** Stored as a new result */
  saved: number;
  /** Already stored exactly as read, so not stored again */
  unchanged: number;
}

export interface ResultSaveOptions {
  /** The stored transmission the results were read from */
  transmissionId?: string;
  /**
   * Store a result only when it differs from every result already stored
   * for the sample and test. Used when reprocessing: a result read the same
   * way twice is the same result, and storing it again would send it to the
   * LIS again.
   */
  skipIdentical?: boolean;
  stats?: ResultSaveStats;
  /**
   * Counts the specimens in the data that could not be read. Reprocessing
   * reads it: a transmission with one is not fully reprocessed, whatever
   * else it yielded.
   */
  unreadable?: { count: number };
}


@Injectable({
  providedIn: 'root'
})

export class InstrumentInterfaceService {
  static readonly MAX_INCOMPLETE_HL7_BYTES = 32 * 1024 * 1024;
  static readonly HL7_BUFFER_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
  // How long a block that is complete but for its <CR> waits for it. The rest
  // of a segment arrives in a fraction of this; an analyzer that never sends a
  // <CR> gives up this much before its result is taken as it stands.
  static readonly MLLP_TERMINATOR_GRACE_MS = 50;
  // An instrument set to ASTM keeps offering its session to an HL7 port every
  // few seconds. Reporting each attempt would bury the log, so the mismatch is
  // reported at most this often per instrument.
  static readonly PROTOCOL_MISMATCH_REPORT_INTERVAL_MS = 10 * 60 * 1000;

  // WHY: TCP chunks from different analyzers can arrive concurrently. A shared
  // buffer can merge two patients' messages, so each configured instrument owns
  // its incomplete HL7 transmission until the frame separator arrives.
  private readonly hl7ReceiveBuffers = new Map<string, string>();
  private readonly hl7BufferExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // A block that is complete but for its <CR>, with the timer waiting for it
  // and the work to take the block as it stands
  private readonly hl7PendingTerminator = new Map<string, { timer: ReturnType<typeof setTimeout>; flush: () => void }>();
  private connectedInstruments = new Map<string, BehaviorSubject<boolean>>();
  private readonly connectionStatusSubscriptions = new Map<string, Subscription>();
  private readonly lastProtocolMismatchReport = new Map<string, number>();
  private readonly resultSavedSubject = new Subject<{ sampleResult: any; instrumentId: string }>();
  public readonly resultSaved$ = this.resultSavedSubject.asObservable();

  constructor(public dbService: DatabaseService,
    public tcpService: TcpConnectionService,
    public utilitiesService: UtilitiesService,
    private hl7Helper: HL7HelperService,
    private astmHelper: ASTMHelperService,
    private readonly electronStoreService?: ElectronStoreService
  ) {
  }

  /**
   * The laboratory's result rules for an instrument, read from its settings
   * when the result is stored, so a change applies to the next result without
   * reconnecting, live or reprocessed.
   */
  private resultRulesFor(instrumentConnectionData: InstrumentConnectionStack): ResultRule[] {
    if (instrumentConnectionData.resultRules !== undefined) {
      return effectiveResultRules({ resultRules: instrumentConnectionData.resultRules }, instrumentConnectionData.connectionProtocol);
    }
    const instruments = this.electronStoreService?.get?.('instrumentsConfig');
    const name = (instrumentConnectionData.instrumentId ?? '').trim().toLowerCase();
    const instrument = Array.isArray(instruments)
      ? instruments.find((candidate: any) => String(candidate?.analyzerMachineName ?? '').trim().toLowerCase() === name)
      : undefined;
    return effectiveResultRules(instrument, instrumentConnectionData.connectionProtocol);
  }


  // Method used to connect to the Testing Machine
  connect(instrument: any) {
    const that = this;
    if (instrument && instrument.connectionParams) {
      that.clearInstrumentReceiveState(instrument.connectionParams.instrumentId);
      // Bind 'this' explicitly to handleTCPResponse
      const boundHandleTCPResponse = that.handleTCPResponse.bind(that);
      that.tcpService.connect(instrument.connectionParams, boundHandleTCPResponse);

      // Update instrument status based on TCP connection status
      that.connectionStatusSubscriptions.get(instrument.connectionParams.instrumentId)?.unsubscribe();
      const statusObservable = that.tcpService.getStatusObservable(instrument.connectionParams);
      if (statusObservable) {
        that.connectionStatusSubscriptions.set(instrument.connectionParams.instrumentId, statusObservable.subscribe(status => {
          that.updateInstrumentStatus(instrument.connectionParams.instrumentId, status);
        }));
      }
    }
  }

  reconnect(instrument: any) {
    const that = this;
    if (instrument && instrument.connectionParams) {
      that.clearInstrumentReceiveState(instrument.connectionParams.instrumentId);
      // Bind 'this' explicitly to handleTCPResponse
      const boundHandleTCPResponse = that.handleTCPResponse.bind(that);
      that.tcpService.reconnect(instrument.connectionParams, boundHandleTCPResponse);

      // Update instrument status based on TCP connection status
      that.connectionStatusSubscriptions.get(instrument.connectionParams.instrumentId)?.unsubscribe();
      const statusObservable = that.tcpService.getStatusObservable(instrument.connectionParams);
      if (statusObservable) {
        that.connectionStatusSubscriptions.set(instrument.connectionParams.instrumentId, statusObservable.subscribe(status => {
          that.updateInstrumentStatus(instrument.connectionParams.instrumentId, status);
        }));
      }
    }
  }

  disconnect(instrument: any) {
    const that = this;
    if (instrument && instrument.connectionParams && instrument.connectionParams.host && instrument.connectionParams.port) {
      that.clearInstrumentReceiveState(instrument.connectionParams.instrumentId);
      that.connectionStatusSubscriptions.get(instrument.connectionParams.instrumentId)?.unsubscribe();
      that.connectionStatusSubscriptions.delete(instrument.connectionParams.instrumentId);
      that.tcpService.disconnect(instrument.connectionParams);
      that.updateInstrumentStatus(instrument.connectionParams.instrumentId, false);
    }
  }

  private clearInstrumentReceiveState(instrumentId: string): void {
    // A block waiting only for its <CR> is a result the analyzer finished
    // sending. Connecting, reconnecting or disconnecting must not be what
    // loses it, so it is taken before the state it sits in is cleared.
    this.flushPendingTerminator(instrumentId);
    this.clearHL7Buffer(instrumentId);
    this.astmHelper.clearInstrumentBuffer(instrumentId);
  }

  // Method used to get connection status for an instrument
  getInstrumentStatus(instrumentId: string): Observable<boolean> {
    if (!this.connectedInstruments.has(instrumentId)) {
      this.connectedInstruments.set(instrumentId, new BehaviorSubject<boolean>(false));
    }
    return this.connectedInstruments.get(instrumentId).asObservable();
  }

  // Method used to update connection status for an instrument
  private updateInstrumentStatus(instrumentId: string, isConnected: boolean): void {
    if (!this.connectedInstruments.has(instrumentId)) {
      this.connectedInstruments.set(instrumentId, new BehaviorSubject<boolean>(false));
    }
    this.connectedInstruments.get(instrumentId).next(isConnected);
  }

  // HL7 processing methods

  /**
   * Acknowledges, reads and saves one HL7 message, choosing the reader for
   * the instrument's machine type. Live and reprocessed messages both come
   * through here, so a stored message is read exactly as it was received.
   */
  processHL7Message(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, options: ResultSaveOptions = {}): Promise<boolean[]> {
    this.acknowledgeHL7(instrumentConnectionData, rawHl7Text);
    return this.saveResults(this.readHL7Results(instrumentConnectionData, rawHl7Text, true, options.unreadable), instrumentConnectionData, options);
  }

  processHL7DataAlinity(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, options: ResultSaveOptions = {}): Promise<boolean[]> {
    this.acknowledgeHL7(instrumentConnectionData, rawHl7Text);
    return this.saveResults(this.readHL7Alinity(instrumentConnectionData, rawHl7Text), instrumentConnectionData, options);
  }

  processHL7Data(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, options: ResultSaveOptions = {}): Promise<boolean[]> {
    this.acknowledgeHL7(instrumentConnectionData, rawHl7Text);
    return this.saveResults(this.readHL7Generic(instrumentConnectionData, rawHl7Text), instrumentConnectionData, options);
  }

  processHL7DataRoche5800(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, options: ResultSaveOptions = {}): Promise<boolean[]> {
    this.acknowledgeHL7(instrumentConnectionData, rawHl7Text);
    return this.saveResults(this.readHL7Generic(instrumentConnectionData, rawHl7Text), instrumentConnectionData, options);
  }

  processHL7DataRoche68008800(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, options: ResultSaveOptions = {}): Promise<boolean[]> {
    this.acknowledgeHL7(instrumentConnectionData, rawHl7Text);
    return this.saveResults(this.readHL7Roche68008800(instrumentConnectionData, rawHl7Text), instrumentConnectionData, options);
  }

  /**
   * The results in one HL7 message, read and not saved or acknowledged.
   * @param report false to read quietly: nothing logged or counted as a
   * failure, for looking at a stored message rather than receiving one
   * @param unreadable counts the specimens that could not be read
   */
  readHL7Results(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, report = true, unreadable?: { count: number }): any[] {
    switch (instrumentConnectionData.machineType) {
      case 'abbott-alinity-m':
        return this.readHL7Alinity(instrumentConnectionData, rawHl7Text, report, unreadable);
      case 'roche-cobas-6800':
      case 'roche-cobas-8800':
        return this.readHL7Roche68008800(instrumentConnectionData, rawHl7Text, report, unreadable);
      default:
        // The cobas 5800 is read as any other HL7 analyzer.
        return this.readHL7Generic(instrumentConnectionData, rawHl7Text, report, unreadable);
    }
  }

  private acknowledgeHL7(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string): void {
    const message = this.hl7Helper.createHL7Message(rawHl7Text.trim());
    const msgID = message.get('MSH.10')?.toString() ?? '';
    const characterSet = message.get('MSH.18')?.toString() ?? 'UNICODE UTF-8';
    const messageProfileIdentifier = message.get('MSH.21')?.toString() ?? '';
    const hl7Version = message.get('MSH.12')?.toString() ?? '2.5.1';

    this.hl7Helper.sendHL7ACK(instrumentConnectionData, msgID, characterSet, messageProfileIdentifier, hl7Version);
  }

  /**
   * Each specimen of each message in the text, with the segments it was read
   * from. A message that cannot be parsed is reported and the others are
   * still read.
   */
  private hl7SpecimensIn(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, report: boolean): ReturnType<HL7HelperService['hl7Specimens']> {
    const specimens: ReturnType<HL7HelperService['hl7Specimens']> = [];
    for (let rawText of rawHl7Text.split('MSH|')) {
      if (rawText.trim() === '') { continue; }

      rawText = 'MSH|' + rawText.trim();
      try {
        const message = this.hl7Helper.createHL7Message(rawText);

        if (!this.hl7Helper.isValidHL7Message(message)) {
          continue;
        }
        specimens.push(...this.hl7Helper.hl7Specimens(rawText, message));
      } catch (error) {
        if (report) {
          this.utilitiesService.logger('error', 'Failed to parse HL7 message: ' + error, instrumentConnectionData.instrumentId);
          this.recordProcessingFailure('hl7_parse_failed', instrumentConnectionData);
        }
      }
    }
    return specimens;
  }

  /**
   * Reads each specimen with `read`. A specimen that cannot be read, or has
   * no result, is reported, counted in `unreadable` and skipped, so it does
   * not take the results of the other specimens in the message with it.
   */
  private readEachSpecimen(
    instrumentConnectionData: InstrumentConnectionStack,
    rawHl7Text: string,
    report: boolean,
    read: (specimen: ReturnType<HL7HelperService['hl7Specimens']>[number]) => any | null,
    unreadable?: { count: number }
  ): any[] {
    const results: any[] = [];
    for (const specimen of this.hl7SpecimensIn(instrumentConnectionData, rawHl7Text, report)) {
      try {
        const result = read(specimen);
        if (result) {
          results.push(result);
        } else if (unreadable) {
          // The reader found no result in the specimen, and has said so.
          unreadable.count++;
        }
      } catch (error) {
        if (unreadable) {
          unreadable.count++;
        }
        this.reportUnreadableSpecimen(instrumentConnectionData, 'Failed to read an HL7 specimen: ' + error, report);
      }
    }
    return results;
  }

  private reportUnreadableSpecimen(instrumentConnectionData: InstrumentConnectionStack, message: string, report: boolean): void {
    if (!report) {
      return;
    }
    this.utilitiesService.logger('error', message, instrumentConnectionData.instrumentId);
    this.recordProcessingFailure('result_parsing_failed', instrumentConnectionData);
  }

  /** The fields every HL7 reader fills the same way from the OBX it chose. */
  private hl7SampleResult(
    instrumentConnectionData: InstrumentConnectionStack,
    specimen: { spm: any; obx: any[]; message: any; text: string },
    singleObx: any,
    ids: { order_id: string; test_id: string },
    resultStatusType: string
  ): any {
    const sampleResult: any = {
      raw_text: specimen.text,
      order_id: ids.order_id,
      test_id: ids.test_id,
      test_type: this.hl7Helper.extractHL7TestType(specimen.message)
    };

    const resultData = this.hl7Helper.processHL7ResultValue(singleObx, resultStatusType);
    sampleResult.results = resultData.results;
    sampleResult.test_unit = resultData.test_unit;
    sampleResult.notes = resultData.notes;

    sampleResult.tested_by = this.hl7Helper.extractHL7TesterInfo(singleObx, specimen.obx, specimen.message);

    sampleResult.result_status = 1;
    sampleResult.lims_sync_status = LIMS_SYNC_STATUS.PENDING;

    const dateTimeFields = this.hl7Helper.extractHL7DateTimeFields(singleObx);
    sampleResult.analysed_date_time = dateTimeFields.analysed_date_time;
    sampleResult.authorised_date_time = dateTimeFields.authorised_date_time;
    sampleResult.result_accepted_date_time = dateTimeFields.result_accepted_date_time;

    sampleResult.test_location = instrumentConnectionData.labName;
    sampleResult.machine_used = instrumentConnectionData.instrumentId;
    return sampleResult;
  }

  private readHL7Alinity(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, report = true, unreadable?: { count: number }): any[] {
    return this.readEachSpecimen(instrumentConnectionData, rawHl7Text, report, specimen => {
      // For Alinity, the first OBX of each SPM is its result
      const singleObx = specimen.obx[0];
      if (!singleObx) {
        this.reportUnreadableSpecimen(instrumentConnectionData, 'No valid OBX segment found for sample in Alinity data', report);
        return null;
      }

      // Alinity sends the sample ID in SPM.3
      const ids = this.hl7Helper.extractHL7OrderAndTestIDs(specimen.spm, specimen.message, 3);
      return this.hl7SampleResult(
        instrumentConnectionData, specimen, singleObx, ids, this.hl7Helper.getHL7ResultStatusType(singleObx)
      );
    }, unreadable);
  }

  private readHL7Generic(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, report = true, unreadable?: { count: number }): any[] {
    return this.readEachSpecimen(instrumentConnectionData, rawHl7Text, report, specimen => {
      let sampleNumber = specimen.spm.get(1).toInteger();
      if (Number.isNaN(sampleNumber)) {
        sampleNumber = 1;
      }

      // In a specimen's own group its first result is its result; the
      // sample number only indexes results across a whole message.
      const singleObx = this.hl7Helper.findAppropriateHL7OBXSegment(specimen.obx, specimen.grouped ? 1 : sampleNumber);
      if (!singleObx) {
        this.reportUnreadableSpecimen(instrumentConnectionData, 'No valid OBX segment found for sample ' + sampleNumber, report);
        return null;
      }

      const ids = this.hl7Helper.extractHL7OrderAndTestIDs(specimen.spm, specimen.message);
      return this.hl7SampleResult(
        instrumentConnectionData, specimen, singleObx, ids, this.hl7Helper.getHL7ResultStatusType(singleObx)
      );
    }, unreadable);
  }

  private readHL7Roche68008800(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string, report = true, unreadable?: { count: number }): any[] {
    return this.readEachSpecimen(instrumentConnectionData, rawHl7Text, report, specimen => {
      const obxArray = specimen.obx;
      let singleObx = null;

      // The result is the OBX with OBX.4 = "1/2"
      obxArray.forEach(function (obx: any) {
        if (obx.get('OBX.4')?.toString() === '1/2') {
          singleObx = obx;
          if ((obx.get('OBX.5.1')?.toString() ?? '') === 'Titer') {
            singleObx = obxArray[0];
          }
        }
      });

      // If no OBX segment with "1/2", fall back to first OBX
      if (!singleObx && obxArray.length > 0) {
        singleObx = obxArray[0];
      }

      if (!singleObx) {
        this.reportUnreadableSpecimen(instrumentConnectionData, 'No valid OBX segment found for Roche 6800/8800', report);
        return null;
      }

      const ids = this.hl7Helper.extractHL7OrderAndTestIDs(specimen.spm, specimen.message);
      return this.hl7SampleResult(
        instrumentConnectionData, specimen, singleObx, ids, this.hl7Helper.getHL7ResultStatusType(singleObx)
      );
    }, unreadable);
  }

  private saveResults(sampleResults: any[], instrumentConnectionData: InstrumentConnectionStack, options: ResultSaveOptions): Promise<boolean[]> {
    if (options.skipIdentical) {
      return this.saveCheckedResults(sampleResults, instrumentConnectionData, options);
    }
    return Promise.all(sampleResults.map(sampleResult => this.saveResult(sampleResult, instrumentConnectionData, options)));
  }

  private receiveASTM(astmProtocolType: string, instrumentConnectionData: InstrumentConnectionStack, data: Buffer) {
    const that = this;
    instrumentConnectionData.transmissionStatusSubject.next(true);
    const astmText = that.utilitiesService.hex2ascii(data.toString('hex'));

    if (astmProtocolType !== COMMUNICATION_PROTOCOL.ASTM_CHECKSUM) {
      // Without checksums there is nothing to verify, but a read can still
      // carry several frames and the ENQ, EOT or NAK around them (a whole
      // session in one read is common on a fast link). Each frame and each
      // control byte is handled as if it had arrived on its own, so a
      // session is completed at its EOT and every message keeps its own
      // stored raw text, however the bytes were split.
      for (const piece of astmText.split(/([\x04\x05\x15])|(?=\x02)/)) {
        if (!piece) {
          continue;
        }
        if (piece === '\x05') {
          // ENQ opens a session: acknowledge it, as in checksum mode, but it
          // is not part of the transmission. Buffering it made an empty
          // session look like one that carried data.
          that.astmHelper.sendACK(instrumentConnectionData, 'Sending ACK');
          continue;
        }
        that.handleASTMChunk(astmProtocolType, instrumentConnectionData, piece);
      }
      return;
    }

    // With checksums, act on whole frames. A frame whose checksum does not
    // match is NAKed so the instrument retransmits it (E1381 section 6.3).
    const tokens = that.astmHelper.assembleASTMFrames(instrumentConnectionData, astmText);
    for (const token of tokens) {
      if (token.kind === 'control' && (token.text === '\x05' || token.text === '\x06')) {
        // ENQ opens a session and ACK answers our own frames: acknowledge,
        // but neither belongs in the stored transmission.
        if (token.text === '\x05') {
          that.astmHelper.resetInboundFrameSequence(instrumentConnectionData.instrumentId);
        }
        that.astmHelper.sendACK(instrumentConnectionData, 'Sending ACK');
        continue;
      }
      if (token.kind === 'trailer') {
        // Framing bytes that arrived after their frame: kept with the stored
        // transmission, not acknowledged and not parsed.
        that.astmHelper.appendFrameTrailer(instrumentConnectionData.instrumentId, token.text);
        continue;
      }
      if (token.kind === 'frame' && !token.valid) {
        that.astmHelper.sendNAK(
          instrumentConnectionData,
          `ASTM checksum mismatch (expected ${token.expected}, received ${token.received}). Sending NAK`
        );
        that.recordProcessingFailure('checksum_mismatch', instrumentConnectionData);
        continue;
      }
      // A frame the instrument sends again because our ACK did not reach it
      // is answered, but must not be added to the transmission twice.
      if (token.kind === 'frame' && that.astmHelper.isRepeatedFrame(instrumentConnectionData.instrumentId, token.text)) {
        that.astmHelper.sendACK(instrumentConnectionData, 'Sending ACK');
        that.utilitiesService.logger('warn', 'Ignored a repeated ASTM frame', instrumentConnectionData.instrumentId);
        continue;
      }
      that.handleASTMChunk(astmProtocolType, instrumentConnectionData, token.text);
    }
  }

  private handleASTMChunk(astmProtocolType: string, instrumentConnectionData: InstrumentConnectionStack, astmText: string) {
    const that = this;

    // Inspect the chunk so we know how to handle it
    const processedInfo = that.astmHelper.processASTMText(astmText);

    if (processedInfo.isNAK) {
      that.astmHelper.sendACK(instrumentConnectionData, 'Sending ACK');
      that.utilitiesService.logger('error', 'NAK Received', instrumentConnectionData.instrumentId);
      that.recordProcessingFailure('instrument_nak', instrumentConnectionData);
      return;
    }

    // ACK before we do any heavy work
    that.astmHelper.sendACK(instrumentConnectionData, 'Sending ACK');

    // Append payload or finalise the transmission via the helper
    const parsingResult = that.astmHelper.appendASTMChunk(instrumentConnectionData, astmText, astmProtocolType, processedInfo);

    if (parsingResult.discarded) {
      return;
    }

    if (parsingResult.completed) {
      instrumentConnectionData.transmissionStatusSubject.next(false);
      const rawDataPayload = parsingResult.rawData ?? '';

      if (!rawDataPayload) {
        // Abbott m2000 opens and closes empty sessions between runs
        that.utilitiesService.logger('info', 'Empty ASTM session closed', instrumentConnectionData.instrumentId);
        return;
      }

      that.utilitiesService.logger('info', 'Received EOT. ASTM payload length: ' + rawDataPayload.length, instrumentConnectionData.instrumentId);
      that.utilitiesService.logger('info', 'Processing ' + astmProtocolType, instrumentConnectionData.instrumentId);

      const transmissionId = uuidv4();
      if (rawDataPayload) {
        const rawData: RawMachineData = {
          data: rawDataPayload,
          machine: instrumentConnectionData.instrumentId,
          instrument_id: instrumentConnectionData.instrumentId,
          transmission_id: transmissionId
        };

        that.dbService.recordRawData(rawData, () => {
          that.utilitiesService.logger('success', 'Successfully saved raw ASTM data', instrumentConnectionData.instrumentId);
        }, (err: any) => {
          that.utilitiesService.logger('error', 'Failed to save raw data : ' + JSON.stringify(err), instrumentConnectionData.instrumentId);
        });
      }

      if (parsingResult.hl7Messages) {
        // Acknowledged frame by frame before the content could be seen, so
        // the instrument will not send these again: the raw data saved above
        // is the only copy.
        that.utilitiesService.logger(
          'error',
          `Received ${parsingResult.hl7Messages} HL7 message(s) but this instrument is set to ASTM here. ` +
          'No results were stored from them; the raw data is kept. Set the instrument and this interface to the same protocol.',
          instrumentConnectionData.instrumentId
        );
        that.recordProcessingFailure('protocol_mismatch_hl7_on_astm', instrumentConnectionData);
      }

      const sampleResults = parsingResult.sampleResults ?? [];
      for (let unreadable = 0; unreadable < (parsingResult.unreadableOrders ?? 0); unreadable++) {
        that.recordProcessingFailure('result_parsing_failed', instrumentConnectionData);
      }
      if (parsingResult.unreadableOrders) {
        that.utilitiesService.logger(
          'error',
          `${parsingResult.unreadableOrders} order(s) in the ASTM transmission could not be read; the raw data is kept`,
          instrumentConnectionData.instrumentId
        );
      }
      if (sampleResults.length === 0) {
        if (parsingResult.hl7Messages) {
          return;
        }
        that.utilitiesService.logger('warn', 'No ASTM results extracted from transmission', instrumentConnectionData.instrumentId);
        that.recordProcessingFailure('no_results_extracted', instrumentConnectionData);
        return;
      }

      for (const sampleResult of sampleResults) {
        that.saveASTMResult(sampleResult, instrumentConnectionData, { transmissionId });
      }
    } else {
      that.utilitiesService.logger('info', astmProtocolType.toUpperCase() + ' | Receiving....' + astmText, instrumentConnectionData.instrumentId);
    }
  }

  private receiveHL7(instrumentConnectionData: InstrumentConnectionStack, data: Buffer) {
    let that = this;
    instrumentConnectionData.transmissionStatusSubject.next(true);
    that.utilitiesService.logger('info', 'Receiving HL7 data', instrumentConnectionData.instrumentId);
    const receivedText = that.utilitiesService.hex2ascii(data.toString('hex'));
    const bufferKey = instrumentConnectionData.instrumentId;

    // ENQ, EOT and STX-framed frames are an instrument speaking ASTM; none of
    // those bytes can occur in HL7. They are taken out and not answered:
    // without our ACK the instrument keeps its results and sends them again
    // once the protocols agree. Only they are taken out, because TCP can
    // deliver them in the same read as a complete HL7 message, which is
    // still read as usual.
    const hl7Text = that.withoutASTMTraffic(receivedText);
    if (hl7Text !== receivedText) {
      that.reportProtocolMismatch(
        instrumentConnectionData,
        'protocol_mismatch_astm_on_hl7',
        'Received ASTM but this instrument is set to HL7 here. Nothing was acknowledged, so the instrument keeps its results. ' +
        'Set the instrument and this interface to the same protocol.'
      );
      if (!hl7Text) {
        instrumentConnectionData.transmissionStatusSubject.next(false);
        return;
      }
    }
    const bufferedData = (that.hl7ReceiveBuffers.get(bufferKey) ?? '') + hl7Text;

    const bufferedBytes = Buffer.byteLength(bufferedData, 'utf8');
    if (bufferedBytes > InstrumentInterfaceService.MAX_INCOMPLETE_HL7_BYTES) {
      that.clearHL7Buffer(bufferKey);
      instrumentConnectionData.transmissionStatusSubject.next(false);
      that.utilitiesService.logger(
        'warn',
        `Discarded incomplete HL7 transmission after ${bufferedBytes} bytes`,
        instrumentConnectionData.instrumentId
      );
      that.recordProcessingFailure('incomplete_transmission_too_large', instrumentConnectionData);
      return;
    }

    that.utilitiesService.logger('info', hl7Text, instrumentConnectionData.instrumentId);

    // MLLP wraps each message as <VT>...<FS><CR>. One chunk may hold several
    // messages, or the tail of one, so take every complete block and keep
    // whatever follows the last <FS> for the next chunk. A block whose <CR>
    // has not arrived waits briefly for it rather than being stored short.
    const { messages, remainder } = that.hl7Helper.extractMLLPMessages(bufferedData, true);
    that.clearHL7TerminatorTimer(bufferKey);

    if (remainder) {
      that.hl7ReceiveBuffers.set(bufferKey, remainder);
      if (that.hl7Helper.endsAtFrameSeparator(remainder)) {
        that.scheduleMLLPTerminatorFlush(instrumentConnectionData);
      } else {
        that.scheduleHL7BufferExpiry(instrumentConnectionData);
      }
    } else {
      // Every received byte belongs to a complete block. Clear before parsing
      // so a parser exception cannot contaminate the next transmission.
      that.clearHL7Buffer(bufferKey);
    }

    that.deliverHL7Messages(instrumentConnectionData, messages);
  }

  /**
   * Stores and parses complete MLLP blocks, in the order they arrived.
   */
  private deliverHL7Messages(instrumentConnectionData: InstrumentConnectionStack, messages: string[]) {
    const that = this;

    if (messages.length === 0) {
      return;
    }

    instrumentConnectionData.transmissionStatusSubject.next(false);
    that.utilitiesService.logger('info', 'Received File Separator Character. Ready to process HL7 data', instrumentConnectionData.instrumentId);

    for (const message of messages) {
      const transmissionId = uuidv4();
      const rawData: RawMachineData = {
        data: message,
        machine: instrumentConnectionData.instrumentId,
        instrument_id: instrumentConnectionData.instrumentId,
        transmission_id: transmissionId
      };
      that.dbService.recordRawData(rawData, () => {
        that.utilitiesService.logger('success', 'Successfully saved raw HL7 data', instrumentConnectionData.instrumentId);
      }, (err: any) => {
        that.utilitiesService.logger('error', 'Failed to save raw data ' + JSON.stringify(err), instrumentConnectionData.instrumentId);
      });

      const completeMessage = that.hl7Helper.unwrapMLLPBlock(message);

      // A block that is not HL7 must not take the socket handler down with it.
      // The processors throw synchronously on a parse failure, which is what
      // this catches. They are not awaited: the promise each returns cannot
      // reject, because saveResult reports a failed save by resolving false.
      try {
        that.processHL7Message(instrumentConnectionData, completeMessage, { transmissionId });
      } catch (error) {
        that.utilitiesService.logger('error', 'Failed to parse HL7 message: ' + error, instrumentConnectionData.instrumentId);
        that.recordProcessingFailure('hl7_parse_failed', instrumentConnectionData);
      }
    }

    instrumentConnectionData.transmissionStatusSubject.next(false);
  }

  /**
   * Bytes that reached an HL7 port with any ASTM traffic taken out: whole
   * frames (STX, frame number, text, ETX or ETB, checksum, CR LF) and the
   * ENQ and EOT around them.
   */
  private withoutASTMTraffic(text: string): string {
    if (!/[\x02\x04\x05]/.test(text)) {
      return text;
    }
    return text
      .replace(/\x02[\s\S]*?(?:[\x03\x17][0-9A-Fa-f]{0,2}\r?\n?|$)/g, '')
      .replace(/[\x04\x05]/g, '');
  }

  /**
   * Reports that the instrument speaks a different protocol from the one set
   * here, at most once per PROTOCOL_MISMATCH_REPORT_INTERVAL_MS.
   */
  private reportProtocolMismatch(instrumentConnectionData: InstrumentConnectionStack, failureCode: string, message: string): void {
    const instrumentId = instrumentConnectionData.instrumentId;
    const now = Date.now();
    const lastReport = this.lastProtocolMismatchReport.get(instrumentId);
    if (lastReport !== undefined && now - lastReport < InstrumentInterfaceService.PROTOCOL_MISMATCH_REPORT_INTERVAL_MS) {
      return;
    }
    this.lastProtocolMismatchReport.set(instrumentId, now);
    this.utilitiesService.logger('error', message, instrumentId);
    this.recordProcessingFailure(failureCode, instrumentConnectionData);
  }

  private clearHL7Buffer(instrumentId: string): void {
    this.hl7ReceiveBuffers.delete(instrumentId);
    const expiryTimer = this.hl7BufferExpiryTimers.get(instrumentId);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      this.hl7BufferExpiryTimers.delete(instrumentId);
    }
    this.clearHL7TerminatorTimer(instrumentId);
  }

  /**
   * Cancels the wait for a <CR> without taking the block. Used when more bytes
   * arrive: they are read again from the buffer, terminator and all.
   */
  private clearHL7TerminatorTimer(instrumentId: string): void {
    const pending = this.hl7PendingTerminator.get(instrumentId);
    if (pending) {
      clearTimeout(pending.timer);
      this.hl7PendingTerminator.delete(instrumentId);
    }
  }

  /**
   * Takes a block that was waiting for its <CR> now, rather than losing it.
   * Used when the connection goes away inside the grace period: the block is
   * complete and the analyzer has already been told nothing is wrong with it.
   */
  private flushPendingTerminator(instrumentId: string): void {
    const pending = this.hl7PendingTerminator.get(instrumentId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.hl7PendingTerminator.delete(instrumentId);
    pending.flush();
  }

  /**
   * Takes a block that is complete but for its <CR> when the <CR> does not
   * come. The block is never discarded: an analyzer that omits the terminator
   * still sent a result, and waiting for a byte it will not send would lose it.
   */
  private scheduleMLLPTerminatorFlush(instrumentConnectionData: InstrumentConnectionStack): void {
    const instrumentId = instrumentConnectionData.instrumentId;
    this.clearHL7TerminatorTimer(instrumentId);

    const flush = () => {
      const buffered = this.hl7ReceiveBuffers.get(instrumentId);
      if (!buffered) {
        return;
      }

      const { messages, remainder } = this.hl7Helper.extractMLLPMessages(buffered, false);
      if (remainder) {
        this.hl7ReceiveBuffers.set(instrumentId, remainder);
        this.scheduleHL7BufferExpiry(instrumentConnectionData);
      } else {
        this.clearHL7Buffer(instrumentId);
      }

      this.deliverHL7Messages(instrumentConnectionData, messages);
    };

    const timer = setTimeout(() => {
      this.hl7PendingTerminator.delete(instrumentId);
      flush();
    }, InstrumentInterfaceService.MLLP_TERMINATOR_GRACE_MS);

    this.hl7PendingTerminator.set(instrumentId, { timer, flush });
  }

  private scheduleHL7BufferExpiry(instrumentConnectionData: InstrumentConnectionStack): void {
    const instrumentId = instrumentConnectionData.instrumentId;
    const existingTimer = this.hl7BufferExpiryTimers.get(instrumentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const expiryTimer = setTimeout(() => {
      const bufferedData = this.hl7ReceiveBuffers.get(instrumentId);
      this.hl7BufferExpiryTimers.delete(instrumentId);
      if (!bufferedData) {
        return;
      }

      this.hl7ReceiveBuffers.delete(instrumentId);
      instrumentConnectionData.transmissionStatusSubject.next(false);
      this.utilitiesService.logger(
        'warn',
        `Discarded inactive HL7 transmission after ${Buffer.byteLength(bufferedData, 'utf8')} bytes`,
        instrumentId
      );
      this.recordProcessingFailure('incomplete_transmission_timeout', instrumentConnectionData);
    }, InstrumentInterfaceService.HL7_BUFFER_INACTIVITY_TIMEOUT_MS);

    this.hl7BufferExpiryTimers.set(instrumentId, expiryTimer);
  }


  handleTCPResponse(connectionIdentifierKey: string, data: Buffer) {
    const that = this;
    const instrumentConnectionData = that.tcpService.connectionStack.get(connectionIdentifierKey);
    if (!instrumentConnectionData) {
      that.utilitiesService.logger('error', `Received data for unknown connection ${connectionIdentifierKey}`, null);
      return;
    }
    // First ensure the instrument is marked as connected
    instrumentConnectionData.statusSubject.next(true);

    // Then process the data based on protocol
    if (instrumentConnectionData.connectionProtocol === COMMUNICATION_PROTOCOL.HL7) {
      that.receiveHL7(instrumentConnectionData, data);
    } else if (instrumentConnectionData.connectionProtocol === COMMUNICATION_PROTOCOL.ASTM_NON_CHECKSUM) {
      that.receiveASTM(COMMUNICATION_PROTOCOL.ASTM_NON_CHECKSUM, instrumentConnectionData, data);
    } else if (instrumentConnectionData.connectionProtocol === COMMUNICATION_PROTOCOL.ASTM_CHECKSUM) {
      that.receiveASTM(COMMUNICATION_PROTOCOL.ASTM_CHECKSUM, instrumentConnectionData, data);
    }
  }

  private saveResult(sampleResult: any, instrumentConnectionData: InstrumentConnectionStack, options: ResultSaveOptions = {}): Promise<boolean> {
    if (!sampleResult) {
      return Promise.resolve(this.reportMissingResult(sampleResult, instrumentConnectionData));
    }
    // A result received live is written at once, as it always was; only a
    // reprocessed one first looks at what is already stored.
    if (options.skipIdentical) {
      return this.saveCheckedResults([sampleResult], instrumentConnectionData, options).then(([saved]) => saved);
    }
    return this.recordResult(this.resultRecord(sampleResult, instrumentConnectionData, options), sampleResult, instrumentConnectionData, options);
  }

  private reportMissingResult(sampleResult: any, instrumentConnectionData: InstrumentConnectionStack): boolean {
    this.utilitiesService.logger('error', 'Failed to save result into the database : ' + JSON.stringify(sampleResult), instrumentConnectionData.instrumentId);
    this.recordProcessingFailure('result_missing', instrumentConnectionData);
    return false;
  }

  /** The row to store for a result: the instrument's rules applied, the value as sent kept beside. */
  private resultRecord(sampleResult: any, instrumentConnectionData: InstrumentConnectionStack, options: ResultSaveOptions): any {
    const interpreted = applyResultRules(sampleResult.results, this.resultRulesFor(instrumentConnectionData));
    return {
      ...sampleResult,
      results: interpreted.value,
      results_as_sent: sampleResult.results ?? null,
      instrument_id: instrumentConnectionData.instrumentId,
      transmission_id: options.transmissionId ?? sampleResult.transmission_id ?? null,
      // These fields are filtered out of the result tables and used only to
      // describe the corresponding PII-free usage event.
      telemetry_machine_type: instrumentConnectionData.machineType,
      telemetry_protocol: instrumentConnectionData.connectionProtocol,
      telemetry_connection_mode: instrumentConnectionData.connectionMode
    };
  }

  /**
   * Saves reprocessed results, skipping each one already stored exactly as
   * read. Every result is compared with what was stored before any of them
   * is saved, and they are then saved one after another, so results of the
   * same transmission never decide each other's fate: a transmission gives
   * the same rows however its saves are timed, and as many as it gave live.
   */
  private async saveCheckedResults(sampleResults: any[], instrumentConnectionData: InstrumentConnectionStack, options: ResultSaveOptions): Promise<boolean[]> {
    const records = sampleResults.map(sampleResult =>
      sampleResult ? this.resultRecord(sampleResult, instrumentConnectionData, options) : null
    );
    const stored = await Promise.all(records.map(record => record ? this.storedState(record) : null));

    const outcomes: boolean[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) {
        outcomes.push(this.reportMissingResult(sampleResults[index], instrumentConnectionData));
        continue;
      }
      if (stored[index].identical) {
        if (options.stats) {
          options.stats.unchanged++;
        }
        outcomes.push(true);
        continue;
      }
      if (stored[index].earlier) {
        record.repeated = 1;
      }
      outcomes.push(await this.recordResult(record, sampleResults[index], instrumentConnectionData, options));
    }
    return outcomes;
  }

  /**
   * Whether a result exactly like this one is stored, and whether any result
   * is stored for the same sample and test. Not knowing is no reason to lose
   * a result: when the check fails, the result is stored.
   */
  private async storedState(record: any): Promise<{ identical: boolean; earlier: boolean }> {
    try {
      if (await this.dbService.findIdenticalResult(record)) {
        return { identical: true, earlier: true };
      }
      return { identical: false, earlier: await this.dbService.hasEarlierResult(record) };
    } catch (error) {
      console.error('Could not check for an identical stored result:', error);
      return { identical: false, earlier: false };
    }
  }

  private recordResult(data: any, sampleResult: any, instrumentConnectionData: InstrumentConnectionStack, options: ResultSaveOptions): Promise<boolean> {
    const that = this;
    return new Promise<boolean>((resolve) => {
      try {
        that.dbService.recordTestResults(
          data,
          () => {
            if (options.stats) {
              options.stats.saved++;
            }
            that.utilitiesService.logger('success', 'Successfully saved result : ' + sampleResult.test_id + '|' + sampleResult.order_id, instrumentConnectionData.instrumentId);
            that.resultSavedSubject.next({ sampleResult: data, instrumentId: instrumentConnectionData.instrumentId });
            resolve(true);
          },
          (err) => {
            that.utilitiesService.logger('error', 'Failed to save result : ' + sampleResult.test_id + '|' + sampleResult.order_id + ' | ' + JSON.stringify(err), instrumentConnectionData.instrumentId);
            that.recordProcessingFailure('result_persistence_failed', instrumentConnectionData, sampleResult.test_type);
            resolve(false);
          }
        );
      } catch (error) {
        that.utilitiesService.logger('error', 'Failed to start result persistence : ' + JSON.stringify(error), instrumentConnectionData.instrumentId);
        that.recordProcessingFailure('result_persistence_failed', instrumentConnectionData, sampleResult.test_type);
        resolve(false);
      }
    });
  }

  /**
   * Saves one result extracted from an ASTM transmission, received live or
   * read back from raw data, with the lab and instrument it came through.
   */
  saveASTMResult(sampleResult: any, instrumentConnectionData: InstrumentConnectionStack, options: ResultSaveOptions = {}): Promise<boolean> {
    sampleResult.test_location = instrumentConnectionData.labName;
    sampleResult.machine_used = instrumentConnectionData.instrumentId;
    return this.saveResult(sampleResult, instrumentConnectionData, options);
  }

  /** As saveASTMResult, for every result of one transmission together. */
  saveASTMResults(sampleResults: any[], instrumentConnectionData: InstrumentConnectionStack, options: ResultSaveOptions = {}): Promise<boolean[]> {
    for (const sampleResult of sampleResults) {
      sampleResult.test_location = instrumentConnectionData.labName;
      sampleResult.machine_used = instrumentConnectionData.instrumentId;
    }
    return this.saveResults(sampleResults, instrumentConnectionData, options);
  }

  private recordProcessingFailure(
    failureCode: string,
    instrument: InstrumentConnectionStack,
    testType?: string
  ): void {
    // Do not include raw payloads, sample identifiers, result values, or error
    // messages. Usage statistics are aggregate operational data, not diagnostic storage.
    void this.dbService.recordTelemetryEvent?.({
      eventType: 'test.processing_failed',
      category: 'failure',
      instrumentId: instrument.instrumentId,
      machineType: instrument.machineType,
      protocol: instrument.connectionProtocol,
      connectionMode: instrument.connectionMode,
      testType,
      outcome: 'failed',
      failureCode
    });
  }


  // TEST ORDERS SECTION

  // Method to fetch orders and send as ASTM messages
  fetchAndSendASTMOrders(instrument: any) {
    let that = this;
    // Fetching orders from the database
    that.dbService.getOrdersToSend(
      (orders: any[]) => { // Assuming getOrdersToSend now returns an array of orders
        if (!orders || orders.length === 0) {
          that.utilitiesService.logger('error', "No orders to send for " + instrument.connectionParams.instrumentId, instrument.connectionParams.instrumentId);
          return;
        }

        orders.forEach(order => {
          // Generate the ASTM message for each order
          const astmMessage = that.astmHelper.generateASTMMessageForOrder(order);

          // Frame the ASTM message with control characters
          const framedMessage = that.astmHelper.frameASTMMessage(astmMessage, instrument.connectionParams.instrumentId);

          // Send the framed message over TCP
          // Assuming tcpService has a method like sendData that takes host, port, and the message
          that.tcpService.sendData(instrument.connectionParams, framedMessage);
        });
      },
      (err: any) => {
        //console.error("Error fetching orders to send:", err);
      }
    );
  }

  fetchAndSendHL7Orders(instrument: any) {
    const that = this;
    that.dbService.getOrdersToSend(
      (orders: any[]) => {
        if (!orders || orders.length === 0) {
          that.utilitiesService.logger('error', 'No orders to send for ' + instrument.connectionParams.instrumentId, instrument.connectionParams.instrumentId);
          return;
        }

        orders.forEach(order => {
          // Generate HL7 message for each order
          const hl7Message = that.hl7Helper.generateHL7MessageForOrder(order);

          // Frame the HL7 message with necessary control characters
          const framedMessage = that.hl7Helper.frameHL7Message(hl7Message);

          // Send the framed message over TCP
          that.tcpService.sendData(instrument.connectionParams, framedMessage);
        });
      },
      (err: any) => {
        console.error('Error fetching orders to send:', err);
      }
    );
  }

}
