import { Injectable } from '@angular/core';
import { DatabaseService } from './database.service';
import { InstrumentConnectionStack } from '../interfaces/instrument-connections.interface';
import { RawMachineData } from '../interfaces/raw-machine-data.interface';
import { UtilitiesService } from './utilities.service';
import { TcpConnectionService } from './tcp-connection.service';
import { HL7HelperService } from './hl7-helper.service';
import { ASTMHelperService } from './astm-helper.service';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { COMMUNICATION_PROTOCOL, LIMS_SYNC_STATUS } from '../constants/domain.constants';


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
  private readonly resultSavedSubject = new Subject<{ sampleResult: any; instrumentId: string }>();
  public readonly resultSaved$ = this.resultSavedSubject.asObservable();

  constructor(public dbService: DatabaseService,
    public tcpService: TcpConnectionService,
    public utilitiesService: UtilitiesService,
    private hl7Helper: HL7HelperService,
    private astmHelper: ASTMHelperService
  ) {
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
  processHL7DataAlinity(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string): Promise<boolean[]> {
    const that = this;
    const persistencePromises: Promise<boolean>[] = [];
    const message = that.hl7Helper.createHL7Message(rawHl7Text.trim());
    const msgID = message.get('MSH.10')?.toString() ?? '';
    const characterSet = message.get('MSH.18')?.toString() ?? 'UNICODE UTF-8';
    const messageProfileIdentifier = message.get('MSH.21')?.toString() ?? '';
    const hl7Version = message.get('MSH.12')?.toString() ?? '2.5.1';

    that.hl7Helper.sendHL7ACK(instrumentConnectionData, msgID, characterSet, messageProfileIdentifier, hl7Version);

    const hl7DataArray = rawHl7Text.split('MSH|');

    hl7DataArray.forEach(function (rawText: string) {
      if (rawText.trim() === '') { return; }

      rawText = 'MSH|' + rawText.trim();
      const message = that.hl7Helper.createHL7Message(rawText);

      if (!that.hl7Helper.isValidHL7Message(message)) {
        return;
      }

      const obx = message.get('OBX').toArray();
      const spm = message.get('SPM');

      spm.forEach(function (singleSpm) {
        // For Alinity, we typically use the first OBX for each SPM
        let singleObx = obx[0];

        // // Fall back to other OBX segments if needed
        // if (!singleObx && obx.length > 0) {
        //   singleObx = obx[0];
        // }

        // Safety check
        if (!singleObx) {
          that.utilitiesService.logger('error', 'No valid OBX segment found for sample in Alinity data', instrumentConnectionData.instrumentId);
          return;
        }

        // Extract order and test IDs (Alinity uses SPM.3)
        const ids = that.hl7Helper.extractHL7OrderAndTestIDs(singleSpm, message, 3);

        const sampleResult: any = {
          raw_text: rawText,
          order_id: ids.order_id,
          test_id: ids.test_id,
          test_type: that.hl7Helper.extractHL7TestType(message)
        };

        // Process result value
        //const resultOutcome = singleObx.get('OBX.5.1')?.toString() ?? '';
        const resultData = that.hl7Helper.processHL7ResultValue(singleObx, that.hl7Helper.getHL7ResultStatusType(singleObx));
        sampleResult.results = resultData.results;
        sampleResult.test_unit = resultData.test_unit;
        sampleResult.notes = resultData.notes;

        // Extract tester info
        sampleResult.tested_by = that.hl7Helper.extractHL7TesterInfo(singleObx, obx, message);

        // Standard fields
        sampleResult.result_status = 1;
        sampleResult.lims_sync_status = LIMS_SYNC_STATUS.PENDING;

        // Extract datetime fields
        const dateTimeFields = that.hl7Helper.extractHL7DateTimeFields(singleObx);
        sampleResult.analysed_date_time = dateTimeFields.analysed_date_time;
        sampleResult.authorised_date_time = dateTimeFields.authorised_date_time;
        sampleResult.result_accepted_date_time = dateTimeFields.result_accepted_date_time;

        // Location information
        sampleResult.test_location = instrumentConnectionData.labName;
        sampleResult.machine_used = instrumentConnectionData.instrumentId;

        persistencePromises.push(that.saveResult(sampleResult, instrumentConnectionData));
      });
    });
    return Promise.all(persistencePromises);
  }

  processHL7Data(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string): Promise<boolean[]> {
    const that = this;
    const persistencePromises: Promise<boolean>[] = [];
    const message = that.hl7Helper.createHL7Message(rawHl7Text.trim());
    const msgID = message.get('MSH.10')?.toString() ?? '';
    const characterSet = message.get('MSH.18')?.toString() ?? 'UNICODE UTF-8';
    const messageProfileIdentifier = message.get('MSH.21')?.toString() ?? '';
    const hl7Version = message.get('MSH.12')?.toString() ?? '2.5.1';

    that.hl7Helper.sendHL7ACK(instrumentConnectionData, msgID, characterSet, messageProfileIdentifier, hl7Version);

    const hl7DataArray = rawHl7Text.split('MSH|');

    hl7DataArray.forEach(function (rawText: string) {
      if (rawText.trim() === '') { return; }

      rawText = 'MSH|' + rawText.trim();
      const message = that.hl7Helper.createHL7Message(rawText);

      if (!that.hl7Helper.isValidHL7Message(message)) {
        return;
      }

      const obx = message.get('OBX').toArray();
      const spm = message.get('SPM');

      spm.forEach(function (singleSpm) {
        // Get sample number and find appropriate OBX segment
        let sampleNumber = singleSpm.get(1).toInteger();
        if (Number.isNaN(sampleNumber)) {
          sampleNumber = 1;
        }

        let singleObx = that.hl7Helper.findAppropriateHL7OBXSegment(obx, sampleNumber);

        // Safety check
        if (!singleObx) {
          that.utilitiesService.logger('error', 'No valid OBX segment found for sample ' + sampleNumber, instrumentConnectionData.instrumentId);
          return;
        }

        // Extract order and test IDs
        const ids = that.hl7Helper.extractHL7OrderAndTestIDs(singleSpm, message);

        const sampleResult: any = {
          raw_text: rawText,
          order_id: ids.order_id,
          test_id: ids.test_id,
          test_type: that.hl7Helper.extractHL7TestType(message)
        };

        // Process result
        const resultStatusType = that.hl7Helper.getHL7ResultStatusType(singleObx);
        const resultData = that.hl7Helper.processHL7ResultValue(singleObx, resultStatusType);
        sampleResult.results = resultData.results;
        sampleResult.test_unit = resultData.test_unit;
        sampleResult.notes = resultData.notes;

        // Extract tester info
        sampleResult.tested_by = that.hl7Helper.extractHL7TesterInfo(singleObx, obx, message);

        // Standard fields
        sampleResult.result_status = 1;
        sampleResult.lims_sync_status = LIMS_SYNC_STATUS.PENDING;

        // Extract datetime fields
        const dateTimeFields = that.hl7Helper.extractHL7DateTimeFields(singleObx);
        sampleResult.analysed_date_time = dateTimeFields.analysed_date_time;
        sampleResult.authorised_date_time = dateTimeFields.authorised_date_time;
        sampleResult.result_accepted_date_time = dateTimeFields.result_accepted_date_time;

        // Location information
        sampleResult.test_location = instrumentConnectionData.labName;
        sampleResult.machine_used = instrumentConnectionData.instrumentId;

        persistencePromises.push(that.saveResult(sampleResult, instrumentConnectionData));
      });
    });
    return Promise.all(persistencePromises);
  }

  processHL7DataRoche5800(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string): Promise<boolean[]> {
    const that = this;
    const persistencePromises: Promise<boolean>[] = [];
    const message = that.hl7Helper.createHL7Message(rawHl7Text.trim());
    const msgID = message.get('MSH.10')?.toString() ?? '';
    const characterSet = message.get('MSH.18')?.toString() ?? 'UNICODE UTF-8';
    const messageProfileIdentifier = message.get('MSH.21')?.toString() ?? '';
    const hl7Version = message.get('MSH.12')?.toString() ?? '2.5.1';

    that.hl7Helper.sendHL7ACK(instrumentConnectionData, msgID, characterSet, messageProfileIdentifier, hl7Version);

    const hl7DataArray = rawHl7Text.split('MSH|');

    hl7DataArray.forEach(function (rawText: string) {
      if (rawText.trim() === '') { return; }

      rawText = 'MSH|' + rawText.trim();
      const message = that.hl7Helper.createHL7Message(rawText);

      if (!that.hl7Helper.isValidHL7Message(message)) {
        return;
      }

      const obx = message.get('OBX').toArray();
      const spm = message.get('SPM');

      spm.forEach(function (singleSpm) {
        // Get sample number and find appropriate OBX segment
        let sampleNumber = singleSpm.get(1).toInteger();
        if (Number.isNaN(sampleNumber)) {
          sampleNumber = 1;
        }

        let singleObx = that.hl7Helper.findAppropriateHL7OBXSegment(obx, sampleNumber);

        // Safety check
        if (!singleObx) {
          that.utilitiesService.logger('error', 'No valid OBX segment found for sample ' + sampleNumber, instrumentConnectionData.instrumentId);
          return;
        }

        // Extract order and test IDs
        const ids = that.hl7Helper.extractHL7OrderAndTestIDs(singleSpm, message);

        const sampleResult: any = {
          raw_text: rawText,
          order_id: ids.order_id,
          test_id: ids.test_id,
          test_type: that.hl7Helper.extractHL7TestType(message)
        };

        // Process result
        const resultStatusType = that.hl7Helper.getHL7ResultStatusType(singleObx);
        const resultData = that.hl7Helper.processHL7ResultValue(singleObx, resultStatusType);
        sampleResult.results = resultData.results;
        sampleResult.test_unit = resultData.test_unit;
        sampleResult.notes = resultData.notes;

        // Extract tester info
        sampleResult.tested_by = that.hl7Helper.extractHL7TesterInfo(singleObx, obx, message);

        // Standard fields
        sampleResult.result_status = 1;
        sampleResult.lims_sync_status = LIMS_SYNC_STATUS.PENDING;

        // Extract datetime fields
        const dateTimeFields = that.hl7Helper.extractHL7DateTimeFields(singleObx);
        sampleResult.analysed_date_time = dateTimeFields.analysed_date_time;
        sampleResult.authorised_date_time = dateTimeFields.authorised_date_time;
        sampleResult.result_accepted_date_time = dateTimeFields.result_accepted_date_time;

        // Location information
        sampleResult.test_location = instrumentConnectionData.labName;
        sampleResult.machine_used = instrumentConnectionData.instrumentId;

        persistencePromises.push(that.saveResult(sampleResult, instrumentConnectionData));
      });
    });
    return Promise.all(persistencePromises);
  }

  processHL7DataRoche68008800(instrumentConnectionData: InstrumentConnectionStack, rawHl7Text: string): Promise<boolean[]> {
    const that = this;
    const persistencePromises: Promise<boolean>[] = [];
    const message = that.hl7Helper.createHL7Message(rawHl7Text.trim());
    const msgID = message.get('MSH.10')?.toString() ?? '';
    const characterSet = message.get('MSH.18')?.toString() ?? 'UNICODE UTF-8';
    const messageProfileIdentifier = message.get('MSH.21')?.toString() ?? '';
    const hl7Version = message.get('MSH.12')?.toString() ?? '2.5.1';

    that.hl7Helper.sendHL7ACK(instrumentConnectionData, msgID, characterSet, messageProfileIdentifier, hl7Version);

    const hl7DataArray = rawHl7Text.split('MSH|');

    hl7DataArray.forEach(function (rawText: string) {
      if (rawText.trim() === '') { return; }

      rawText = 'MSH|' + rawText.trim();
      const message = that.hl7Helper.createHL7Message(rawText);

      if (!that.hl7Helper.isValidHL7Message(message)) {
        return;
      }

      const obxArray = message.get('OBX').toArray();
      const spm = message.get('SPM');

      spm.forEach(function (singleSpm: any) {
        // For 6800/8800, look for OBX with OBX.4 = "1/2"
        let resultOutcome = '';
        let singleObx = null;

        // This specific logic for 6800/8800 looks for "1/2" in OBX.4
        obxArray.forEach(function (obx: any) {
          if (obx.get('OBX.4')?.toString() === '1/2') {
            resultOutcome = obx.get('OBX.5.1')?.toString() ?? '';
            singleObx = obx;
            if (resultOutcome === 'Titer') {
              singleObx = obxArray[0];
              resultOutcome = obx.get('OBX.5.1')?.toString() ?? '';
            }
          }
        });

        // If no OBX segment with "1/2", fall back to first OBX
        if (!singleObx && obxArray.length > 0) {
          singleObx = obxArray[0];
          resultOutcome = singleObx.get('OBX.5.1')?.toString() ?? '';
        }

        // Safety check
        if (!singleObx) {
          that.utilitiesService.logger('error', 'No valid OBX segment found for Roche 6800/8800', instrumentConnectionData.instrumentId);
          return;
        }

        // Extract order and test IDs
        const ids = that.hl7Helper.extractHL7OrderAndTestIDs(singleSpm, message);

        const sampleResult: any = {
          raw_text: rawText,
          order_id: ids.order_id,
          test_id: ids.test_id,
          test_type: that.hl7Helper.extractHL7TestType(message)
        };

        // Process result
        const resultStatusType = that.hl7Helper.getHL7ResultStatusType(singleObx);
        const resultData = that.hl7Helper.processHL7ResultValue(singleObx, resultStatusType);
        sampleResult.results = resultData.results;
        sampleResult.test_unit = resultData.test_unit;
        sampleResult.notes = resultData.notes;

        // Extract tester info
        sampleResult.tested_by = that.hl7Helper.extractHL7TesterInfo(singleObx, obxArray, message);

        // Standard fields
        sampleResult.result_status = 1;
        sampleResult.lims_sync_status = LIMS_SYNC_STATUS.PENDING;

        // Extract datetime fields
        const dateTimeFields = that.hl7Helper.extractHL7DateTimeFields(singleObx);
        sampleResult.analysed_date_time = dateTimeFields.analysed_date_time;
        sampleResult.authorised_date_time = dateTimeFields.authorised_date_time;
        sampleResult.result_accepted_date_time = dateTimeFields.result_accepted_date_time;

        // Location information
        sampleResult.test_location = instrumentConnectionData.labName;
        sampleResult.machine_used = instrumentConnectionData.instrumentId;

        persistencePromises.push(that.saveResult(sampleResult, instrumentConnectionData));
      });
    });
    return Promise.all(persistencePromises);
  }


  private receiveASTM(astmProtocolType: string, instrumentConnectionData: InstrumentConnectionStack, data: Buffer) {
    const that = this;
    instrumentConnectionData.transmissionStatusSubject.next(true);
    const astmText = that.utilitiesService.hex2ascii(data.toString('hex'));

    if (astmProtocolType !== COMMUNICATION_PROTOCOL.ASTM_CHECKSUM) {
      // Without checksums there is nothing to verify, but ENQ, EOT and NAK
      // still say where a session starts and ends, and they are only
      // recognised on their own. A read can carry them together with frames
      // (a whole session in one read is common on a fast link), so they are
      // separated first. Otherwise the EOT is buffered as data, the session is
      // never completed, and its results wait for the next session's EOT or
      // are lost when the connection drops.
      for (const piece of astmText.split(/([\x04\x05\x15])/)) {
        if (piece) {
          that.handleASTMChunk(astmProtocolType, instrumentConnectionData, piece);
        }
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

      if (rawDataPayload) {
        const rawData: RawMachineData = {
          data: rawDataPayload,
          machine: instrumentConnectionData.instrumentId,
          instrument_id: instrumentConnectionData.instrumentId
        };

        that.dbService.recordRawData(rawData, () => {
          that.utilitiesService.logger('success', 'Successfully saved raw ASTM data', instrumentConnectionData.instrumentId);
        }, (err: any) => {
          that.utilitiesService.logger('error', 'Failed to save raw data : ' + JSON.stringify(err), instrumentConnectionData.instrumentId);
        });
      }

      const sampleResults = parsingResult.sampleResults ?? [];
      if (sampleResults.length === 0) {
        that.utilitiesService.logger('warn', 'No ASTM results extracted from transmission', instrumentConnectionData.instrumentId);
        that.recordProcessingFailure('no_results_extracted', instrumentConnectionData);
        return;
      }

      for (const sampleResult of sampleResults) {
        sampleResult.test_location = instrumentConnectionData.labName;
        sampleResult.machine_used = instrumentConnectionData.instrumentId;
        that.saveResult(sampleResult, instrumentConnectionData);
      }
    } else {
      that.utilitiesService.logger('info', astmProtocolType.toUpperCase() + ' | Receiving....' + astmText, instrumentConnectionData.instrumentId);
    }
  }

  private receiveHL7(instrumentConnectionData: InstrumentConnectionStack, data: Buffer) {
    let that = this;
    instrumentConnectionData.transmissionStatusSubject.next(true);
    that.utilitiesService.logger('info', 'Receiving HL7 data', instrumentConnectionData.instrumentId);
    const hl7Text = that.utilitiesService.hex2ascii(data.toString('hex'));
    const bufferKey = instrumentConnectionData.instrumentId;
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
      const rawData: RawMachineData = {
        data: message,
        machine: instrumentConnectionData.instrumentId,
        instrument_id: instrumentConnectionData.instrumentId
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
        if (instrumentConnectionData.machineType === 'abbott-alinity-m') {
          that.processHL7DataAlinity(instrumentConnectionData, completeMessage);
        }
        else if (instrumentConnectionData.machineType === 'roche-cobas-5800') {
          that.processHL7DataRoche5800(instrumentConnectionData, completeMessage);
        }
        else if (instrumentConnectionData.machineType === 'roche-cobas-6800') {
          that.processHL7DataRoche68008800(instrumentConnectionData, completeMessage);
        }
        else {
          that.processHL7Data(instrumentConnectionData, completeMessage);
        }
      } catch (error) {
        that.utilitiesService.logger('error', 'Failed to parse HL7 message: ' + error, instrumentConnectionData.instrumentId);
        that.recordProcessingFailure('hl7_parse_failed', instrumentConnectionData);
      }
    }

    instrumentConnectionData.transmissionStatusSubject.next(false);
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

  private saveResult(sampleResult: any, instrumentConnectionData: InstrumentConnectionStack): Promise<boolean> {
    const that = this;
    if (!sampleResult) {
      that.utilitiesService.logger('error', 'Failed to save result into the database : ' + JSON.stringify(sampleResult), instrumentConnectionData.instrumentId);
      that.recordProcessingFailure('result_missing', instrumentConnectionData);
      return Promise.resolve(false);
    }

    const data = {
      ...sampleResult,
      instrument_id: instrumentConnectionData.instrumentId,
      // These fields are filtered out of the result tables and used only to
      // describe the corresponding PII-free usage event.
      telemetry_machine_type: instrumentConnectionData.machineType,
      telemetry_protocol: instrumentConnectionData.connectionProtocol,
      telemetry_connection_mode: instrumentConnectionData.connectionMode
    };
    return new Promise<boolean>((resolve) => {
      try {
        that.dbService.recordTestResults(
          data,
          () => {
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

  private saveASTMDataBlock(dataArray: {}, partData: string, instrumentConnectionData: InstrumentConnectionStack): Promise<boolean> {
    const that = this;

    const segmentTypes = Object.keys(dataArray);
    that.utilitiesService.logger('info', 'Processing ASTM segments: ' + (segmentTypes.length ? segmentTypes.join(', ') : 'none'), instrumentConnectionData.instrumentId);

    // Extract sample result from the ASTM data
    const sampleResult = that.astmHelper.extractSampleResultFromASTM(dataArray, partData);

    if (sampleResult) {
      // Add location information
      sampleResult.test_location = instrumentConnectionData.labName;
      sampleResult.machine_used = instrumentConnectionData.instrumentId;

      // Save the result
      return that.saveResult(sampleResult, instrumentConnectionData);
    } else {
      that.utilitiesService.logger('error', 'Order record not found in the following ASTM data block', instrumentConnectionData.instrumentId);
      that.utilitiesService.logger('error', JSON.stringify(dataArray), instrumentConnectionData.instrumentId);
      that.recordProcessingFailure('result_parsing_failed', instrumentConnectionData);
      return Promise.resolve(false);
    }
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

  processStoredASTMDataBlock(dataArray: {}, partData: string, instrumentConnectionData: InstrumentConnectionStack): Promise<boolean> {
    return this.saveASTMDataBlock(dataArray, partData, instrumentConnectionData);
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
