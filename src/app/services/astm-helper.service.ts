// ASTM Helper Service

import { Injectable } from '@angular/core';
import { UtilitiesService } from './utilities.service';
import { LIMS_SYNC_STATUS } from '../constants/domain.constants';

export interface ASTMProcessingResult {
  completed: boolean;
  discarded?: boolean;
  rawData?: string;
  sampleResults?: any[];
  /** Orders present in the transmission whose result could not be read. */
  unreadableOrders?: number;
  /** Messages in the transmission that were HL7, not ASTM, and were not read. */
  hl7Messages?: number;
}

export interface ASTMExtraction {
  results: any[];
  /**
   * Groups that carry an order record but produced no result. Distinct from
   * a group without an order record at all, such as a lone header, which is
   * not a result and not a failure.
   */
  unreadableOrders: number;
  /**
   * True when the message is HL7 sent inside ASTM framing: the instrument is
   * set to HL7 while this side expects ASTM. Nothing is read from it.
   */
  isHL7?: boolean;
}

/**
 * One unit pulled out of the inbound byte stream in checksum mode.
 *
 * - `control`: a single ENQ, EOT, ACK or NAK byte.
 * - `frame`: a complete <STX>...<ETX|ETB>cc[<CR><LF>] frame. `valid` says
 *   whether the two checksum characters matched the frame contents.
 * - `trailer`: the CR/LF that follow a frame and arrived after it. Framing
 *   only: kept so the stored transmission is what was received, never
 *   acknowledged and never parsed.
 * - `unframed`: text that is not inside a frame. Some analyzers do not frame
 *   every byte, so this is passed through the way every chunk was before
 *   frame validation existed.
 */
export interface ASTMFrameToken {
  kind: 'control' | 'frame' | 'unframed' | 'trailer';
  text: string;
  valid?: boolean;
  expected?: string;
  received?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ASTMHelperService {
  static readonly MAX_INCOMPLETE_BUFFER_BYTES = 32 * 1024 * 1024;
  static readonly BUFFER_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
  // Control characters
  protected NAK = '\x15'; // Negative Acknowledge
  protected STX = '\x02'; // Start of Text
  protected ETX = '\x03'; // End of Text
  protected ETB = '\x17'; // End of Transmission Block
  protected EOT = '\x04'; // End of Transmission
  protected ENQ = '\x05'; // Enquiry
  protected ACK = '\x06'; // Acknowledge
  protected LF = '\x0A'; // Line Feed
  protected CR = '\x0D'; // Carriage Return

  protected START = '##START##';
  // Buffer for ACK character
  // This is used to send an ACK response to the instrument after processing a message
  // It is defined as a Buffer to ensure it is sent in the correct binary format
  private readonly ACK_BUFFER = Buffer.from('\x06', 'binary');
  private readonly NAK_BUFFER = Buffer.from('\x15', 'binary');
  // E1381 frame numbers run 1..7 then 0, and restart at 1 for each message.
  private static readonly FRAME_NUMBER_MODULUS = 8;

  // Track sequence numbers for different instruments
  private astmSequenceNumbers: Map<string, number> = new Map();
  // Buffer ASTM payloads per instrument until we receive EOT
  private astmBuffers: Map<string, string> = new Map();
  // Bytes of a frame that has not finished arriving yet (checksum mode only)
  private astmFrameBuffers: Map<string, string> = new Map();
  private astmBufferExpiryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Frame number of the last frame accepted from each instrument, so a frame
  // the instrument sends again is recognised as the same one
  private lastAcceptedFrameNumbers: Map<string, string> = new Map();

  constructor(private utilitiesService: UtilitiesService) { }

  /**
 * Gets the START marker for ASTM message processing
 * @returns START marker string
 */
  getStartMarker(): string {
    return this.START;
  }

  /**
 * Sends ACK immediately with minimal overhead for ASTM protocol
 * @param instrumentConnectionData The instrument connection to send ACK to
 * @param logMessage Optional message to log (defaults to generic ACK message)
 */
  sendACK(instrumentConnectionData: any, logMessage?: string): void {
    try {
      if (instrumentConnectionData &&
        instrumentConnectionData.connectionSocket &&
        instrumentConnectionData.connectionSocket.writable) {

        const startTime = Date.now();
        this.utilitiesService.logger('info', logMessage || 'Sending ASTM ACK', instrumentConnectionData.instrumentId);
        // Send pre-created ACK buffer immediately
        instrumentConnectionData.connectionSocket.write(this.ACK_BUFFER, 'binary', () => {
          const endTime = Date.now();
          const duration = endTime - startTime;
          this.utilitiesService.logger('info', `ACK sent in ${duration}ms`, instrumentConnectionData.instrumentId);
        });
      }
    } catch (error) {
      this.utilitiesService.logger('error', 'Failed to send ASTM ACK: ' + error, instrumentConnectionData.instrumentId);
    }
  }

  /**
   * Sends NAK so the instrument retransmits the last frame (E1381 section 6.3).
   * Only used in checksum mode, when a frame fails checksum verification.
   */
  sendNAK(instrumentConnectionData: any, logMessage?: string): void {
    try {
      if (instrumentConnectionData &&
        instrumentConnectionData.connectionSocket &&
        instrumentConnectionData.connectionSocket.writable) {
        this.utilitiesService.logger('warn', logMessage || 'Sending ASTM NAK', instrumentConnectionData.instrumentId);
        instrumentConnectionData.connectionSocket.write(this.NAK_BUFFER, 'binary');
      }
    } catch (error) {
      this.utilitiesService.logger('error', 'Failed to send ASTM NAK: ' + error, instrumentConnectionData.instrumentId);
    }
  }

  /**
   * Splits the inbound byte stream into control bytes, complete frames and
   * unframed text. Bytes of a frame that has not finished arriving are kept
   * per instrument until the next chunk. Used in checksum mode only.
   * @param instrumentConnectionData Connection the bytes came from
   * @param chunk The newly received bytes
   * @returns Tokens that are complete and ready to be acted on
   */
  assembleASTMFrames(instrumentConnectionData: any, chunk: string): ASTMFrameToken[] {
    const instrumentId = instrumentConnectionData?.instrumentId;
    if (!instrumentId) {
      return [];
    }

    const buffered = (this.astmFrameBuffers.get(instrumentId) ?? '') + chunk;
    const { tokens, remainder } = this.extractASTMFrames(buffered);

    if (!remainder) {
      this.astmFrameBuffers.delete(instrumentId);
      return tokens;
    }

    if (Buffer.byteLength(remainder, 'utf8') > ASTMHelperService.MAX_INCOMPLETE_BUFFER_BYTES) {
      this.clearInstrumentBuffer(instrumentId);
      instrumentConnectionData.transmissionStatusSubject?.next(false);
      this.utilitiesService.logger('warn', 'Discarded oversized incomplete ASTM frame', instrumentId);
      return tokens;
    }

    this.astmFrameBuffers.set(instrumentId, remainder);
    this.scheduleBufferExpiry(instrumentConnectionData);
    return tokens;
  }

  /**
   * Pure tokenizer behind assembleASTMFrames.
   * @param buffered Bytes received so far that have not been consumed
   * @returns Complete tokens and the bytes still waiting for more data
   */
  extractASTMFrames(buffered: string): { tokens: ASTMFrameToken[]; remainder: string } {
    const tokens: ASTMFrameToken[] = [];
    const controlBytes = [this.ENQ, this.EOT, this.ACK, this.NAK];
    let buffer = buffered;

    while (buffer.length > 0) {
      const first = buffer.charAt(0);

      if (controlBytes.includes(first)) {
        tokens.push({ kind: 'control', text: first });
        buffer = buffer.slice(1);
        continue;
      }

      // CR/LF that trail a frame may arrive in a later chunk, once the frame
      // itself has been handed on. They carry no records and are not a frame
      // to acknowledge, but they are bytes the instrument sent: kept apart as
      // a trailer so the stored transmission reads the same however the TCP
      // chunks happened to fall.
      if (first === this.CR || first === this.LF) {
        let end = 1;
        while (end < buffer.length && (buffer.charAt(end) === this.CR || buffer.charAt(end) === this.LF)) {
          end++;
        }
        tokens.push({ kind: 'trailer', text: buffer.slice(0, end) });
        buffer = buffer.slice(end);
        continue;
      }

      if (first === this.STX) {
        const terminatorIndex = this.findFrameTerminator(buffer, 1);
        // Wait for <ETX|ETB> plus the two checksum characters
        if (terminatorIndex === -1 || buffer.length < terminatorIndex + 3) {
          break;
        }

        let end = terminatorIndex + 3;
        if (buffer.charAt(end) === this.CR) {
          end++;
        }
        if (buffer.charAt(end) === this.LF) {
          end++;
        }

        const frameText = buffer.slice(0, end);
        const expected = this.calculateChecksum(frameText);
        const received = buffer.slice(terminatorIndex + 1, terminatorIndex + 3).toUpperCase();
        tokens.push({ kind: 'frame', text: frameText, valid: expected === received, expected, received });
        buffer = buffer.slice(end);
        continue;
      }

      // Not a frame: pass through up to the next STX or control byte
      let end = buffer.length;
      for (let i = 1; i < buffer.length; i++) {
        const current = buffer.charAt(i);
        if (current === this.STX || controlBytes.includes(current)) {
          end = i;
          break;
        }
      }
      tokens.push({ kind: 'unframed', text: buffer.slice(0, end) });
      buffer = buffer.slice(end);
    }

    return { tokens, remainder: buffer };
  }

  /**
   * True when this frame repeats the one accepted before it.
   *
   * E1381 numbers frames 1..7 then 0, so consecutive frames never carry the
   * same number: a repeat means our ACK did not reach the instrument and it
   * sent the frame again (section 6.3). The frame must still be acknowledged,
   * but appending it a second time duplicates its records — and a duplicated
   * O record becomes a second order with no result records behind it, saved
   * as a failure against a sample that in fact has a result.
   *
   * Call once per accepted frame: it records the number as it answers.
   * @param instrumentId Instrument the frame came from
   * @param frameText The complete frame, starting with STX
   */
  isRepeatedFrame(instrumentId: string, frameText: string): boolean {
    if (!instrumentId || frameText.charAt(0) !== this.STX) {
      return false;
    }

    const frameNumber = frameText.charAt(1);
    if (!/^[0-7]$/.test(frameNumber)) {
      return false;
    }

    if (this.lastAcceptedFrameNumbers.get(instrumentId) === frameNumber) {
      return true;
    }

    this.lastAcceptedFrameNumbers.set(instrumentId, frameNumber);
    return false;
  }

  /**
   * Keeps the CR/LF that followed a frame with the transmission being
   * accumulated. Only while one is open: a stray CR between sessions is not
   * the start of a transmission and must not turn an empty session into a
   * non-empty one.
   * @param instrumentId Instrument the bytes came from
   * @param trailer The CR/LF bytes
   */
  appendFrameTrailer(instrumentId: string, trailer: string): void {
    const buffered = this.astmBuffers.get(instrumentId);
    if (!instrumentId || !buffered) {
      return;
    }
    this.astmBuffers.set(instrumentId, buffered + trailer);
  }

  /**
   * Forgets the last accepted frame number, so the next frame is judged on its
   * own. Used when a session opens: the instrument restarts at frame 1.
   */
  resetInboundFrameSequence(instrumentId: string): void {
    this.lastAcceptedFrameNumbers.delete(instrumentId);
  }

  private findFrameTerminator(buffer: string, fromIndex: number): number {
    for (let i = fromIndex; i < buffer.length; i++) {
      const current = buffer.charAt(i);
      if (current === this.ETX || current === this.ETB) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Gets ASTM data blocks from an array of ASTM segments
   * @param astmArray Array of ASTM segments
   * @returns Object containing ASTM data blocks organized by segment type
   */
  getASTMDataBlock(astmArray: any[]): any {
    let dataArray = {};

    for (const element of astmArray) {
      if (element !== '' && element !== null && element !== undefined) {
        // Remove leading digits and split the segment into its constituent fields
        const segmentFields = element.replace(/^\d*/, '').split('|');

        // Use the first character (segment type) as the key
        const segmentType = segmentFields[0].charAt(0);

        // Check if this type of segment has already been encountered
        if (!dataArray[segmentType]) {
          dataArray[segmentType] = [segmentFields]; // Initialize with the current segment's fields
        } else {
          dataArray[segmentType].push(segmentFields); // Append this segment's fields to the array of segments of the same type
        }
      }
    }

    return dataArray;
  }

  /**
   * Generates an ASTM message for an order
   * @param sampleResult Order data to include in the message
   * @returns Formatted ASTM message string
   */
  generateASTMMessageForOrder(sampleResult: any): string {
    // Assuming order fields map directly to ASTM message fields
    // This will vary based on your specific ASTM message format requirements
    let message = `H|\\^&|||${sampleResult.test_location}|||||||P|1\r`;
    message += `P|1||||${sampleResult.order_id}|||||||||||||||||||||||\r`;
    message += `O|1|${sampleResult.test_id}|${sampleResult.test_id}||${sampleResult.test_type}||||||||||||||O\r`;
    message += `L|1|N\r`;

    return message;
  }

  /**
   * Frames an ASTM message with control characters and checksum
   * @param message The ASTM message to frame
   * @param instrumentId The instrument ID for tracking sequence numbers
   * @returns Framed ASTM message ready for transmission
   */
  frameASTMMessage(message: string, instrumentId: string): string {
    const sequenceNumber = this.getAndUpdateSequenceNumber(instrumentId);
    const header = this.STX + sequenceNumber;
    const footer = this.ETX;
    const checksum = this.calculateChecksum(header + message + footer);
    // EOT ends the message, so the next message starts again at frame 1
    this.resetSequenceNumber(instrumentId);
    return header + message + footer + checksum + this.CR + this.LF + this.EOT;
  }

  /**
   * Calculates the checksum of an ASTM message
   * @param message Message to calculate checksum for
   * @returns Checksum as a hexadecimal string
   */
  calculateChecksum(message: string): string {
    let checksum = 0;

    // Remove STX if present
    const startIndex = message.startsWith('\x02') ? 1 : 0;
    // The checksum covers everything after STX up to and including ETX or ETB
    const terminatorIndex = this.findFrameTerminator(message, startIndex);
    const endIndex = terminatorIndex !== -1 ? terminatorIndex + 1 : message.length;
    const adjustedMessage = message.substring(startIndex, endIndex);

    // Calculate checksum
    for (let i = 0; i < adjustedMessage.length; i++) {
      checksum += adjustedMessage.charCodeAt(i);
    }
    checksum &= 0xFF; // Keep only the last 8 bits

    // Convert to 2-digit hexadecimal string, uppercased
    const hexChecksum = checksum.toString(16).toUpperCase().padStart(2, '0');

    return hexChecksum;
  }

  /**
   * Gets and updates the sequence number for an instrument
   * @param instrumentId Instrument ID to track sequence for
   * @returns Current sequence number as a string
   */
  getAndUpdateSequenceNumber(instrumentId: string): string {
    const lastSequence = this.astmSequenceNumbers.get(instrumentId);
    // First frame of a message is 1; then 2..7, 0, 1, ... (E1381 6.3.2)
    const nextSequence = lastSequence === undefined
      ? 1
      : (lastSequence + 1) % ASTMHelperService.FRAME_NUMBER_MODULUS;
    this.astmSequenceNumbers.set(instrumentId, nextSequence);
    return nextSequence.toString();
  }

  /**
   * Resets the sequence number so the next frame for this instrument is 1
   * @param instrumentId Instrument ID to reset sequence for
   */
  resetSequenceNumber(instrumentId: string): void {
    this.astmSequenceNumbers.delete(instrumentId);
  }

  clearInstrumentBuffer(instrumentId: string): void {
    this.astmBuffers.delete(instrumentId);
    this.astmFrameBuffers.delete(instrumentId);
    this.lastAcceptedFrameNumbers.delete(instrumentId);
    const expiryTimer = this.astmBufferExpiryTimers.get(instrumentId);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      this.astmBufferExpiryTimers.delete(instrumentId);
    }
  }

  /**
   * Appends an ASTM data chunk to the instrument buffer and, when EOT is received,
   * returns the accumulated payload together with parsed sample results.
   */
  appendASTMChunk(
    instrumentConnectionData: any,
    astmText: string,
    protocolType: string,
    processedInfo: { text: string; isHeader: boolean; isEOT: boolean; isNAK: boolean }
  ): ASTMProcessingResult {
    const instrumentId = instrumentConnectionData?.instrumentId;
    if (!instrumentId) {
      return { completed: false };
    }

    // Initialize buffer if needed
    if (!this.astmBuffers.has(instrumentId)) {
      this.astmBuffers.set(instrumentId, '');
    }

    // When EOT is received, process the accumulated payload and reset the buffer
    if (processedInfo.isEOT) {
      const accumulatedPayload = this.astmBuffers.get(instrumentId) ?? '';
      this.clearInstrumentBuffer(instrumentId);

      if (!accumulatedPayload) {
        this.utilitiesService.logger('warn', 'EOT received without accumulated ASTM payload', instrumentId);
        return { completed: true, rawData: '' };
      }

      this.utilitiesService.logger('info', 'Processing completed ASTM transmission', instrumentId);

      const withChecksum = protocolType !== 'astm-nonchecksum';
      let astmData = this.utilitiesService.removeControlCharacters(accumulatedPayload, withChecksum);
      if (this.isHL7Transmission(astmData)) {
        return { completed: true, rawData: accumulatedPayload, sampleResults: [], unreadableOrders: 0, hl7Messages: 1 };
      }
      const fullDataArray = astmData.split(this.START);

      const sampleResults: any[] = [];
      let unreadableOrders = 0;
      let hl7Messages = 0;

      for (const partData of fullDataArray) {
        if (!partData) {
          continue;
        }

        const astmArray = partData.split(/<CR>/);

        if (!Array.isArray(astmArray) || astmArray.length === 0) {
          continue;
        }

        if (Object.keys(this.getASTMDataBlock(astmArray)).length === 0) {
          this.utilitiesService.logger('info', 'No ASTM data extracted from chunk', instrumentId);
          continue;
        }

        const extraction = this.extractASTMResults(astmArray, partData);
        if (extraction.isHL7) {
          hl7Messages++;
          continue;
        }
        sampleResults.push(...extraction.results);
        unreadableOrders += extraction.unreadableOrders;
        if (extraction.results.length === 0) {
          this.utilitiesService.logger('warn', 'Failed to extract sample result from ASTM chunk', instrumentId);
        }
      }

      return {
        completed: true,
        rawData: accumulatedPayload,
        sampleResults,
        unreadableOrders,
        hl7Messages
      };
    }

    // For normal payload frames, append the data (header frames are pre-processed).
    // A frame after one that ended in ETB continues the record it cut, so it
    // cannot start a message however its text begins: a GeneXpert cut inside
    // "LOW-INH|" leaves a frame starting "H|", and marking it as a new
    // message split the record in two.
    const bufferedPayload = this.astmBuffers.get(instrumentId) ?? '';
    const continuesFrame = /\x17[0-9A-Fa-f]{0,2}[\r\n]*$/.test(bufferedPayload);
    const payloadToAppend = processedInfo.isHeader && !continuesFrame ? processedInfo.text : astmText;
    const updatedPayload = bufferedPayload + payloadToAppend;

    if (Buffer.byteLength(updatedPayload, 'utf8') > ASTMHelperService.MAX_INCOMPLETE_BUFFER_BYTES) {
      const bufferedBytes = Buffer.byteLength(updatedPayload, 'utf8');
      this.clearInstrumentBuffer(instrumentId);
      instrumentConnectionData.transmissionStatusSubject?.next(false);
      this.utilitiesService.logger(
        'warn',
        `Discarded incomplete ASTM transmission after ${bufferedBytes} bytes`,
        instrumentId
      );
      return { completed: false, discarded: true };
    }

    this.astmBuffers.set(instrumentId, updatedPayload);
    this.scheduleBufferExpiry(instrumentConnectionData);

    return { completed: false };
  }

  private scheduleBufferExpiry(instrumentConnectionData: any): void {
    const instrumentId = instrumentConnectionData.instrumentId;
    const existingTimer = this.astmBufferExpiryTimers.get(instrumentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const expiryTimer = setTimeout(() => {
      const bufferedData = (this.astmBuffers.get(instrumentId) ?? '') + (this.astmFrameBuffers.get(instrumentId) ?? '');
      this.astmBufferExpiryTimers.delete(instrumentId);
      if (!bufferedData) {
        return;
      }

      this.astmBuffers.delete(instrumentId);
      this.astmFrameBuffers.delete(instrumentId);
      instrumentConnectionData.transmissionStatusSubject?.next(false);
      this.utilitiesService.logger(
        'warn',
        `Discarded inactive ASTM transmission after ${Buffer.byteLength(bufferedData, 'utf8')} bytes`,
        instrumentId
      );
    }, ASTMHelperService.BUFFER_INACTIVITY_TIMEOUT_MS);

    this.astmBufferExpiryTimers.set(instrumentId, expiryTimer);
  }

  /**
   * Processes a received ASTM message
   * @param astmText The ASTM text to process
   * @param withChecksum Whether the message includes a checksum
   * @returns Object containing processed ASTM data
   */
  processASTMText(astmText: string, withChecksum: boolean = true): any {
    // Step 1: Control character removal
    const cleanedForHeaderCheck = astmText.replace(/[\x00-\x1F\x7F]/g, '');

    // Step 2: use regex pattern to check if the text starts with a header
    const regexToCheckIfHeader = /^\d*H\|/; // Added the | after H

    const isHeader = regexToCheckIfHeader.test(cleanedForHeaderCheck);

    if (isHeader) {
      astmText = this.START + astmText;
    }

    return {
      text: astmText,
      isHeader: isHeader,
      isEOT: astmText === this.EOT,
      isNAK: astmText === this.NAK
    };
  }

  /**
   * Splits the records of one message into one group per order record.
   *
   * A batch upload carries one H record and then P/O/R records for several
   * patients. Records before the first O record (H, and any P or C) are
   * shared by every group; each O record starts a new group that keeps the
   * records after it until the next O record.
   * @param astmArray Records of one message, in transmission order
   * @returns One record array per order, or a single array when there is no O record
   */
  splitASTMRecordsByOrder(astmArray: string[]): string[][] {
    const preamble: string[] = [];
    const groups: string[][] = [];
    let current: string[] | null = null;

    for (const record of astmArray) {
      const recordType = (record ?? '').replace(/^\d*/, '').charAt(0);
      if (recordType === 'O') {
        current = [...preamble, record];
        groups.push(current);
      } else if (current) {
        current.push(record);
      } else {
        preamble.push(record);
      }
    }

    return groups.length > 0 ? groups : [astmArray];
  }

  /**
   * The records that belong to each order record of a message, in order: the
   * message header (every record before the first patient or order), the
   * patient record the order follows with that patient's own records, and
   * the order with the records after it up to the next patient, order or
   * terminator. What a result keeps as its raw text, so it never carries
   * another patient's record.
   * @param astmArray Records of one message, in transmission order
   */
  ownRecordsByOrder(astmArray: string[]): string[][] {
    const typeOf = (record: string) => (record ?? '').replace(/^\d*/, '').charAt(0);
    const header: string[] = [];
    let patient: string[] = [];
    let order: string[] | null = null;
    const orders: string[][] = [];
    let seenPatientOrOrder = false;

    for (const record of astmArray) {
      if (!record) {
        continue;
      }
      const recordType = typeOf(record);
      if (recordType === 'P') {
        seenPatientOrOrder = true;
        patient = [record];
        order = null;
      } else if (recordType === 'O') {
        seenPatientOrOrder = true;
        order = [...header, ...patient, record];
        orders.push(order);
      } else if (recordType === 'L') {
        order = null;
      } else if (order) {
        order.push(record);
      } else if (seenPatientOrOrder) {
        patient.push(record);
      } else {
        header.push(record);
      }
    }
    return orders;
  }

  /**
   * Extracts one sample result per order record in a message
   * @param astmArray Records of one message, in transmission order
   * @param partData Raw ASTM part data
   * @returns Sample results in transmission order, each with the records it
   * was read from as its raw text; empty when no order could be read
   */
  extractSampleResultsFromASTM(astmArray: string[], partData: string): any[] {
    return this.extractASTMResults(astmArray, partData).results;
  }

  /**
   * As extractSampleResultsFromASTM, and also counts the orders that could
   * not be read, so a result that is lost is reported rather than skipped.
   */
  extractASTMResults(astmArray: string[], partData: string): ASTMExtraction {
    const results: any[] = [];
    let unreadableOrders = 0;
    // Read as ASTM, each HL7 segment would become a record of its first
    // letter: every OBX an order with no result, stored as a failure against
    // a sample ID of "ST". It is refused whole instead.
    if (this.isHL7Message(astmArray)) {
      return { results, unreadableOrders, isHL7: true };
    }
    const ownRecords = this.ownRecordsByOrder(astmArray);
    this.splitASTMRecordsByOrder(astmArray).forEach((group, index) => {
      const dataArray = this.getASTMDataBlock(group);
      if (Object.keys(dataArray).length === 0) {
        return;
      }
      const sampleResult = this.extractSampleResultFromASTM(dataArray, partData);
      if (sampleResult) {
        // This order's own records, not the whole message: a batch repeated
        // on every result it carries grew the database by the square of its
        // size. The whole transmission is kept in raw data.
        sampleResult.raw_text = (ownRecords[index] ?? group).join('<CR>');
        results.push(sampleResult);
      } else if (dataArray['O']?.length > 0) {
        unreadableOrders++;
      }
    });
    return { results, unreadableOrders };
  }

  /**
   * True when the records are HL7 segments rather than ASTM records. An
   * instrument set to HL7 can still frame its messages the ASTM way (the
   * GeneXpert did, sending messages it had queued before its protocol was
   * changed), so the framing alone does not tell them apart. An ASTM record
   * type is one letter; an MSH segment cannot be mistaken for one.
   * @param astmArray Records of one message, frame numbers not yet removed
   */
  isHL7Message(astmArray: string[]): boolean {
    return astmArray.some(record => /^\d*MSH\|/.test(record ?? ''));
  }

  /**
   * isHL7Message for a whole transmission, control characters removed,
   * before it is split into messages. Checked whole because a message start
   * marked inside an HL7 message (older builds did, where a frame happened to
   * begin "H|") would leave a part with no MSH segment to recognise.
   * @param astmData Transmission as returned by removeControlCharacters
   */
  isHL7Transmission(astmData: string): boolean {
    return this.isHL7Message(astmData.split(this.START).join('<CR>').split('<CR>'));
  }

  /**
   * Extracts sample result information from ASTM data blocks
   * @param dataArray ASTM data blocks
   * @param partData Raw ASTM part data
   * @returns Sample result object or null if extraction fails
   */
  extractSampleResultFromASTM(dataArray: any, partData: string): any | null {
    const sampleResult: any = {};

    try {
      if (dataArray['O'] && dataArray['O'].length > 0) {
        const oSegmentFields = dataArray['O'][0]; // dataArray['O'] is an array of arrays (each sub-array is a segment's fields)

        const primarySpecimenId = oSegmentFields[2]?.trim();
        // O.4 is "specimenId^run^well" on Abbott m2000; keep only the identifier
        const instrumentSpecimenId = oSegmentFields[3]?.trim().split('^')[0];

        sampleResult.order_id = primarySpecimenId;
        // ASTM O.1 is only the record sequence number. Use the analyzer's
        // specimen identifier when supplied, otherwise retain the primary ID.
        sampleResult.test_id = instrumentSpecimenId || primarySpecimenId;

        const resultStatus = oSegmentFields[25]; // X = Failed, F = Final, P = Preliminary

        // An order record can end before its test identifier; that is no
        // reason to lose the result that follows it.
        const universalTestIdentifier = oSegmentFields[4] ?? '';
        const testTypeDetails = universalTestIdentifier.split('^');
        const testType = testTypeDetails.length > 1 ? testTypeDetails[3] : ''; // Adjust based on your ASTM format

        sampleResult.test_type = testType;
        let otherOutcomes: string[] = [];

        if (dataArray['R'] && dataArray['R'].length > 0) {
          const outcomes = this.isGeneXpert(dataArray) ? this.namedOutcomes(dataArray['R']) : [];
          // The first outcome that has a value is the result. When an earlier
          // one is empty (an Ultra run with only a trace of MTB sends an
          // empty "MTB" and "DETECTED" under "MTB Trace") the value alone
          // would read as a plain detection, so it keeps its name.
          const reported = outcomes.find(outcome => outcome.value);
          const rSegmentFields = reported?.fields ?? dataArray['R'][0];

          if (!sampleResult.test_type) {
            sampleResult.test_type = (rSegmentFields[2]) ? rSegmentFields[2].replace('^^^', '') : rSegmentFields[2];
          }

          let testUnit = rSegmentFields[4];
          if (testUnit) {
            testUnit = this.utilitiesService.decodeHtmlEntities(testUnit);
          }
          sampleResult.test_unit = testUnit;

          let finalResult = this.resultValue(rSegmentFields);
          // Both words are the analyzer's own: the outcome's name from R.3 and
          // its value from R.4. "DETECTED" alone would reach the LIS as MTB
          // detected when the analyzer said only a trace of it, with RIF
          // resistance indeterminate: a different result, stored silently.
          if (finalResult && reported && reported !== outcomes[0]) {
            finalResult = `${reported.name} ${finalResult}`;
          }

          // The other outcomes of the same test (RIF resistance on Ultra, each
          // drug on MTB-XDR) are part of the result and go with it, every one
          // that has a value. One is never dropped for repeating the result's
          // value: "RIF Resistance DETECTED" beside "MTB DETECTED" is the
          // resistance, not a repeat.
          otherOutcomes = outcomes
            .filter(outcome => outcome !== reported && outcome.value)
            .map(outcome => this.utilitiesService.decodeHtmlEntities(`${outcome.name} ${outcome.value}`));

          if (finalResult) {
            finalResult = this.utilitiesService.decodeHtmlEntities(finalResult);
          }

          sampleResult.results = finalResult;
          sampleResult.tested_by = rSegmentFields[10];
          sampleResult.analysed_date_time = this.utilitiesService.formatRawDate(rSegmentFields[12]);
          sampleResult.authorised_date_time = this.utilitiesService.formatRawDate(rSegmentFields[12]);
          sampleResult.result_accepted_date_time = this.utilitiesService.formatRawDate(rSegmentFields[12]);
        } else {
          sampleResult.test_type = testType;
          sampleResult.test_unit = null;
          sampleResult.results = 'Failed';
          sampleResult.tested_by = null;
          sampleResult.analysed_date_time = null;
          sampleResult.authorised_date_time = null;
          sampleResult.result_accepted_date_time = null;
        }

        sampleResult.raw_text = partData;
        sampleResult.result_status = resultStatus === 'F' ? 1 : 0;
        sampleResult.lims_sync_status = LIMS_SYNC_STATUS.PENDING;
        const comments = this.extractASTMComments(dataArray);
        sampleResult.notes = [...otherOutcomes, ...(comments ? [comments] : [])].join(' | ');

        return sampleResult;
      }

      return null;
    } catch (error) {
      console.error("Error extracting sample result from ASTM:", error);
      return null;
    }
  }

  /**
   * The value of an R record: R.4, or its second component when the first is
   * empty (GeneXpert sends "NOT DETECTED^" but a viral load as "^1234.56").
   */
  private resultValue(rSegmentFields: string[]): string | null {
    const components = (rSegmentFields[3] ?? '').split('^');
    return components[0]?.trim() || components[1]?.trim() || null;
  }

  /**
   * True when the H record names the sender as a GeneXpert
   * ("...^GeneXpert^6.5" in H.5).
   */
  private isGeneXpert(dataArray: any): boolean {
    return (dataArray['H'] ?? []).some((fields: string[]) => /\^GeneXpert\^/i.test(fields[4] ?? ''));
  }

  /**
   * The R records of a GeneXpert message that report a named outcome of the
   * test, in order, as opposed to the Ct, endpoint and control readings
   * behind them. The outcome is named in R.3
   * ("^UV2^^TBPos^Xpert MTB-RIF Ultra^4^MTB^": assay name in the fifth
   * component, outcome name in the seventh, nothing after it). A reading
   * such as the viral load "LOG" line has no outcome name. Other analyzers
   * lay R.3 out differently, so this is for GeneXpert only.
   */
  private namedOutcomes(rRecords: string[][]): { fields: string[]; name: string; value: string | null }[] {
    return rRecords
      .map(fields => ({ fields, components: (fields[2] ?? '').split('^') }))
      .filter(({ components }) => components[4]?.trim() && components[6]?.trim() && !components[7]?.trim())
      .map(({ fields, components }) => ({ fields, name: components[6].trim(), value: this.resultValue(fields) }));
  }

  /**
   * Joins the text of the C (comment) records of an order. Abbott m2000
   * explains a failed order this way, e.g. "4442 : Internal control cycle
   * number is too high."
   */
  extractASTMComments(dataArray: any): string {
    const comments: string[] = [];
    for (const fields of dataArray['C'] ?? []) {
      // GeneXpert sends "Error^2097^Operation terminated^Error 2097: ...^<timestamp>";
      // the last component that is not a timestamp is the full description.
      const components = (fields[3] ?? '').split('^').map((part: string) => part.trim()).filter((part: string) => part && !/^\d{14}$/.test(part));
      const text = components.length > 0 ? components[components.length - 1] : '';
      if (text) {
        comments.push(this.utilitiesService.decodeHtmlEntities(text));
      }
    }
    return comments.join(' | ');
  }

  /**
   * Determines if a received ASTM message is a control character
   * @param astmText ASTM text to check
   * @returns Object indicating which control character (if any) the text is
   */
  isControlCharacter(astmText: string): {
    isControl: boolean,
    type: 'ACK' | 'NAK' | 'EOT' | 'STX' | 'ETX' | 'ENQ' | 'none'
  } {
    if (astmText === this.ACK) {
      return { isControl: true, type: 'ACK' };
    } else if (astmText === this.NAK) {
      return { isControl: true, type: 'NAK' };
    } else if (astmText === this.EOT) {
      return { isControl: true, type: 'EOT' };
    } else if (astmText === this.STX) {
      return { isControl: true, type: 'STX' };
    } else if (astmText === this.ETX) {
      return { isControl: true, type: 'ETX' };
    } else if (astmText === this.ENQ) {
      return { isControl: true, type: 'ENQ' };
    }

    return { isControl: false, type: 'none' };
  }
}
