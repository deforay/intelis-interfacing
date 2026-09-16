// HL7 Helper Service

import { Injectable } from '@angular/core';
import type { Message } from 'hl7parser';
import { UtilitiesService } from './utilities.service';

const randomUUID = () => (window as any).require('crypto').randomUUID();

@Injectable({
  providedIn: 'root'
})
export class HL7HelperService {
  public hl7parser = require('hl7parser');
  private readonly rocheObx8OutcomeMap: Record<string, string> = {
    BT: 'Target Not Detected',
    ND: 'Target Not Detected'
  };

  constructor(private utilitiesService: UtilitiesService) { }

  /**
   * Generates an HL7 ACK (acknowledgment) message
   * @param messageID Message ID to acknowledge
   * @param characterSet Character set to use in response
   * @param messageProfileIdentifier Message profile identifier
   * @param hl7Version HL7 version to use (default: 2.5.1)
   * @returns Formatted HL7 ACK message
   */
  /**
 * Generates an optimized HL7 ACK (acknowledgment) message with detailed field mapping
 * @param messageID Message ID to acknowledge (goes to MSH-10 in response, MSA-2 for original msg)
 * @param characterSet Character set to use in response (MSH-18)
 * @param messageProfileIdentifier Message profile identifier (MSH-21)
 * @param hl7Version HL7 version to use (MSH-12, default: 2.5.1)
 * @returns Formatted HL7 ACK message
 */
  generateHL7ACK(messageID: string | number, characterSet: string, messageProfileIdentifier: string, hl7Version = '2.5.1'): string {
    // Handle empty/null parameters
    if (!messageID || messageID === '') {
      messageID = Math.random().toString();
    }
    if (!characterSet || characterSet === '') {
      characterSet = 'UNICODE UTF-8';
    }
    if (!messageProfileIdentifier || messageProfileIdentifier === '') {
      messageProfileIdentifier = '';
    }

    // Pre-create control characters for better performance
    const VT = '\x0B';  // Start of message
    const CR = '\x0D';  // Carriage return
    const FS = '\x1C';  // End of message

    // Generate timestamp once
    const moment = require('moment');
    const date = moment().format('YYYYMMDDHHmmss');

    // Build optimized ACK message with field position comments
    const ack = `${VT}MSH|^~\\&|InteLIS|InteLIS|InteLIS|InteLIS|${date}||ACK^R22^ACK|${randomUUID()}|P|${hl7Version}|||NE|AL||${characterSet}||${messageProfileIdentifier}${CR}MSA|AA|${messageID}${CR}${FS}${CR}`;

    /*
    MSH Field Breakdown:
    MSH|          - Message Header (segment ID)
    ^~\&|         - MSH-2: Encoding Characters
    InteLIS|         - MSH-3: Sending Application
    InteLIS|         - MSH-4: Sending Facility
    InteLIS|         - MSH-5: Receiving Application
    InteLIS|         - MSH-6: Receiving Facility
    ${date}|      - MSH-7: Date/Time of Message
    |             - MSH-8: Security (empty)
    ACK^R22^ACK|  - MSH-9: Message Type (ACK^Event^Message Structure)
    ${randomUUID()}| - MSH-10: Message Control ID (new UUID for this ACK)
    P|            - MSH-11: Processing ID (P=Production)
    ${hl7Version}| - MSH-12: Version ID
    |             - MSH-13: Sequence Number (empty)
    |             - MSH-14: Continuation Pointer (empty)
    NE|           - MSH-15: Accept Acknowledgment Type (NE=Never)
    AL|           - MSH-16: Application Acknowledgment Type (AL=Always)
    |             - MSH-17: Country Code (empty)
    ${characterSet}| - MSH-18: Character Set
    |             - MSH-19: Principal Language (empty)
    |             - MSH-20: Alternate Character Set Handling (empty)
    ${messageProfileIdentifier} - MSH-21: Message Profile Identifier

    MSA Field Breakdown:
    MSA|          - Message Acknowledgment (segment ID)
    AA|           - MSA-1: Acknowledgment Code (AA=Application Accept)
    ${messageID}  - MSA-2: Message Control ID (from original message)
    */

    return ack;
  }

  /**
 * Sends HL7 ACK immediately with minimal overhead
 * @param instrumentConnectionData The instrument connection to send ACK to
 * @param msgID Message ID to acknowledge
 * @param characterSet Character set for the ACK
 * @param messageProfileIdentifier Message profile identifier
 * @param hl7Version HL7 version (default: 2.5.1)
 */
  sendHL7ACK(instrumentConnectionData: any, msgID: string, characterSet: string = 'UNICODE UTF-8', messageProfileIdentifier: string = '', hl7Version: string = '2.5.1'): void {
    try {
      if (instrumentConnectionData &&
        instrumentConnectionData.connectionSocket &&
        instrumentConnectionData.connectionSocket.writable) {

        // Generate and send ACK immediately
        const ackMessage = this.generateHL7ACK(msgID, characterSet, messageProfileIdentifier, hl7Version);
        instrumentConnectionData.connectionSocket.write(ackMessage);
        this.utilitiesService.logger('info', 'Sent HL7 ACK for message: ' + msgID, instrumentConnectionData.instrumentId);
      }
    } catch (error) {
      this.utilitiesService.logger('error', 'Failed to send HL7 ACK: ' + error, instrumentConnectionData.instrumentId);
    }
  }

  /**
 * Finds the most appropriate OBX segment for processing HL7 test results
 * Prioritizes test result segments over metadata segments
 * @param obxArray Array of OBX segments
 * @param sampleNumber Sample number to match
 * @returns The most appropriate OBX segment or null if none found
 */
  findAppropriateHL7OBXSegment(obxArray: any[], sampleNumber: number): any {
    // First try to find an OBX segment that matches this sample number in OBX.4.
    // A run-time range is never a result, whatever its OBX.4 says.
    for (const currentObx of obxArray) {
      if ((currentObx.get('OBX.2')?.toString() ?? '') === 'DR' && (currentObx.get('OBX.3.1')?.toString() ?? '') === 'RunTimeRange') {
        continue;
      }
      const obx4Value = currentObx.get('OBX.4')?.toString() ?? '';
      if (obx4Value && (obx4Value === sampleNumber.toString() || obx4Value === `${sampleNumber}/2`)) {
        return currentObx;
      }
    }

    // Look for test result OBX segments (exclude runtime/metadata segments)
    const testResultObxSegments = obxArray.filter(obx => {
      const obxType = obx.get('OBX.2')?.toString() ?? '';
      const obxIdentifier = obx.get('OBX.3.1')?.toString() ?? '';

      // Skip runtime/metadata segments
      if (obxType === 'DR' && obxIdentifier === 'RunTimeRange') {
        return false;
      }

      // Look for actual test result segments (usually ST type with test identifiers)
      return obxType === 'ST' || obxIdentifier.includes('HIV') || obxIdentifier.includes('0BHIV1');
    });

    // If we found test result segments, use them
    if (testResultObxSegments.length > 0) {
      // For the specific sample number, try to find the corresponding test result OBX
      let targetIndex = sampleNumber - 1; // Convert to 0-based index

      // If the calculated index is within bounds, use it
      if (targetIndex >= 0 && targetIndex < testResultObxSegments.length) {
        return testResultObxSegments[targetIndex];
      }

      // Otherwise, return the last available test result segment
      return testResultObxSegments[testResultObxSegments.length - 1];
    }

    // FALLBACK: Use the original logic but prefer later OBX segments (which typically contain results)
    let index = (sampleNumber * 2) - 1;
    if (index >= obxArray.length) {
      // Instead of defaulting to index 0, prefer the last OBX segment
      index = obxArray.length - 1;
    }

    return index >= 0 && index < obxArray.length ? obxArray[index] : null;
  }

  /**
   * Extracts the technician/tested by information from HL7 segments
   * @param primaryObx Primary OBX segment to check first
   * @param allObx All available OBX segments to check as fallback
   * @param message Full HL7 message to check OBR segment as final fallback
   * @returns Technician/tested by name or empty string if not found
   */
  extractHL7TesterInfo(primaryObx: any, allObx: any[], message: any): string {
    // First try the primary OBX segment
    let testerName = primaryObx.get('OBX.16')?.toString() ?? '';

    // If not found, look through all OBX segments
    if (!testerName && allObx.length > 0) {
      for (const obx of allObx) {
        const name = obx.get('OBX.16')?.toString() ?? '';
        if (name) {
          testerName = name;
          break;
        }
      }
    }

    // Last resort: check OBR segment
    if (!testerName) {
      testerName = message.get('OBR.34')?.toString() ?? ''; // OBR.34 sometimes contains technician ID
    }

    return testerName;
  }

  /**
   * Processes HL7 result data and formats it according to result type
   * @param singleObx OBX segment containing result data
   * @param resultStatusType Status of the result
   * @returns Object containing result value and unit
   */
  processHL7ResultValue(singleObx: any, resultStatusType: string): { results: string, test_unit: string, notes: string } {
    let raw = (singleObx.get('OBX.5.1')?.toString() ?? '').trim();
    raw = this.utilitiesService.decodeHtmlEntities(raw);
    if (!raw) {
      // Roche can put outcome/error flags in OBX-8 when OBX-5 is empty.
      raw = this.extractObx8Outcome(singleObx);
    }
    const v = raw.toLowerCase();

    // Preserve literal textual outcomes
    if (['invalid', 'failed', 'not detected', 'target not detected'].includes(v)) {
      return { results: raw, test_unit: '', notes: '' };
    }

    const resultOutcome = raw; // Use decoded value


    if (resultStatusType === 'ERROR') {
      // Keep results clean for LIS usage while preserving instrument-specific detail in notes.
      const notes = raw && !['failed', 'invalid'].includes(v) ? raw : '';
      return { results: 'Failed', test_unit: '', notes };
    } else if (resultStatusType === 'INCOMPLETE') {
      const notes = raw && !['incomplete'].includes(v) ? raw : '';
      return { results: 'Incomplete', test_unit: '', notes };
    }

    // Process based on result value
    if (resultOutcome === 'Titer') {
      let testUnit = singleObx.get('OBX.6.1')?.toString() ?? '';
      testUnit = this.utilitiesService.decodeHtmlEntities(testUnit);

      return {
        results: resultOutcome,
        test_unit: testUnit,
        notes: ''
      };
    } else if (resultOutcome === 'Target Not Detected' || resultOutcome === '> Titer max') {
      // Stored as sent. Rewriting either, for instance "> Titer max" to
      // "> 10000000", is a laboratory's result rule, not the parser's.
      return { results: resultOutcome, test_unit: '', notes: '' };
    } else if (
      resultOutcome === 'Target Not Detected' ||
      resultOutcome === 'Failed' ||
      resultOutcome === 'Invalid' ||
      resultOutcome === 'Not Detected') {
      return { results: resultOutcome, test_unit: '', notes: '' };
    } else {
      // Values are stored exactly as the analyzer reports them. Roche X800
      // sends a mantissa with a UCUM power-of-ten unit (763 with
      // 10*-1.{Copies}/mL) and cobas 4800 sends 3.26E+05 cp/mL; reading
      // those is the LIS's responsibility, not this tool's.
      const testUnit = this.utilitiesService.decodeHtmlEntities(this.extractHL7Unit(singleObx));

      return {
        results: resultOutcome,
        test_unit: testUnit,
        notes: ''
      };
    }
  }

  /**
   * Reads the unit from OBX-6, taking the first non-empty component.
   * Abbott Alinity m sends "^Copies/mL" (identifier empty, text filled), and
   * Roche sends "copies/mL^^UCUM"; both must yield the human-readable unit.
   */
  extractHL7Unit(singleObx: any): string {
    const candidates = [
      singleObx.get('OBX.6.1')?.toString(),
      singleObx.get('OBX.6.2')?.toString(),
      singleObx.get('OBX.6')?.toString()
    ];
    for (const candidate of candidates) {
      // Trimmed only to decide whether the component says anything. The unit
      // that is stored is the field as the analyzer wrote it.
      const inspected = (candidate ?? '').trim();
      if (inspected && !inspected.startsWith('^')) {
        return candidate;
      }
    }
    return '';
  }

  private extractObx8Outcome(singleObx: any): string {
    const rawObx8 = (singleObx.get('OBX.8')?.toString() ?? '').trim();
    if (!rawObx8) {
      return '';
    }

    const [firstRepeat = ''] = rawObx8.split('~');
    const [code = '', text = '', codingSystem = ''] = firstRepeat.split('^').map(part => part.trim());

    const normalizedCode = code.toUpperCase();
    const normalizedSystem = codingSystem.toUpperCase();

    if (normalizedSystem === '99ROC' && this.rocheObx8OutcomeMap[normalizedCode]) {
      return this.rocheObx8OutcomeMap[normalizedCode];
    }

    if (text) {
      return this.utilitiesService.decodeHtmlEntities(text);
    }

    return normalizedCode || rawObx8;
  }

  /**
   * Extracts order and test IDs from HL7 message
   * @param spm SPM segment
   * @param message Full HL7 message
   * @param fieldPosition Field position in SPM segment (2 or 3 depending on instrument)
   * @returns Object with order_id and test_id
   */
  extractHL7OrderAndTestIDs(spm: any, message: any, fieldPosition: number = 2): { order_id: string, test_id: string } {
    // A specimen segment can end before the field; that is an empty ID, not a
    // reason to lose every specimen in the message.
    const idValue = (spm.get(`SPM.${fieldPosition}`)?.toString() ?? '').replace('&ROCHE', '');

    if (idValue) {
      return { order_id: idValue, test_id: idValue };
    } else {
      // Fallback to SAC.3
      const sacValue = message.get('SAC.3')?.toString() ?? '';
      return { order_id: sacValue, test_id: sacValue };
    }
  }

  /**
   * Extracts the test type from the HL7 message
   * @param message HL7 message
   * @returns Test type string
   */
  extractHL7TestType(message: any): string {
    return message.get('OBR.4.2')?.toString() ?? message.get('OBX.3.2')?.toString() ?? 'HIVVL';
  }

  /**
   * Extracts and formats datetime fields from HL7 message
   * @param obxSegment OBX segment containing datetime
   * @returns Object with formatted datetime fields
   */
  extractHL7DateTimeFields(obxSegment: any): {
    analysed_date_time: string,
    authorised_date_time: string,
    result_accepted_date_time: string
  } {
    const dateTimeValue = obxSegment.get('OBX.19')?.toString() ?? '';
    const formattedDateTime = this.utilitiesService.formatRawDate(dateTimeValue);

    return {
      analysed_date_time: formattedDateTime,
      authorised_date_time: formattedDateTime,
      result_accepted_date_time: formattedDateTime
    };
  }

  /**
   * Determines the result status type from an OBX segment
   * @param singleObx OBX segment to analyze
   * @returns Status type as string (ERROR, INCOMPLETE, or FINAL)
   */
  getHL7ResultStatusType(singleObx: any): string {
    const resultStatus = singleObx.get('OBX.11')?.toString().toUpperCase() ?? '';
    const resultValue = singleObx.get('OBX.5.1')?.toString().toLowerCase() ?? '';
    const obx8Code = (singleObx.get('OBX.8.1')?.toString() ?? '').trim().toUpperCase();
    const badValues = ['failed', 'invalid'];
    if (resultStatus === 'X' || badValues.includes(resultValue) || this.isRocheErrorFlag(obx8Code)) {
      return 'ERROR';
    }
    if (['I', 'R'].includes(resultStatus)) {
      return 'INCOMPLETE';
    }
    return 'FINAL';
  }

  private isRocheErrorFlag(code: string): boolean {
    if (!code) {
      return false;
    }

    // Roche analyzer issue flags are commonly Uxx/UxxT-style codes (e.g. U06T).
    return /^U\d{2}[A-Z]?$/.test(code);
  }

  /**
   * Generates an HL7 message for an order to be sent to an instrument
   * @param sampleResult Order/sample data
   * @returns Formatted HL7 message string
   */
  generateHL7MessageForOrder(sampleResult: any): string {
    const moment = require('moment');
    const date = moment(new Date()).format('YYYYMMDDHHmmss');

    let message = 'MSH|^~\\&|LIS|LISFacility|Roche|x800|' + date + '||ORM^O01|' + randomUUID() + '|P|2.3\r';
    message += 'PID|||123456^^^LIS||Doe^John\r';
    message += 'ORC|NW|' + sampleResult.order_id + '|||' + date + '\r';
    message += 'OBR|1||' + sampleResult.order_id + '^LIS|' + sampleResult.test_id + '^' + sampleResult.test_type + '^L\r';

    return message;
  }

  /**
   * Frames an HL7 message with control characters
   * @param message The HL7 message to frame
   * @returns Framed HL7 message ready for transmission
   */
  frameHL7Message(message: string): string {
    return '\x0B' + message + '\x1C' + '\x0D'; // \x0B is the start block, \x1C is the end block, and \x0D is carriage return
  }

  /**
   * Creates a new HL7 message from raw text
   * @param rawHl7Text Raw HL7 text to parse
   * @returns Parsed HL7 message object
   */
  createHL7Message(rawHl7Text: string): Message {
    return this.hl7parser.create(rawHl7Text.trim());
  }

  /**
   * Every specimen in one HL7 message, each with the segments that belong to
   * it: its SPM, and the OBX segments and message to read its ID, test type
   * and result from.
   *
   * A message with one specimen is returned as it is, so the analyzers that
   * send a message per sample are read exactly as before. A message with
   * several is split into one group per SPM (the SPM and every segment after
   * it up to the next SPM, behind the message header), so no specimen can be
   * given another's sample ID, test type or result: the first SAC, the first
   * OBR and the last result OBX of the message belong to one specimen only.
   *
   * The split relies on the OUL^R22 order, specimen before its results, which
   * is what every analyzer captured so far sends. A message whose results come
   * before its first specimen cannot be split that way and is read as a
   * whole, as it always was.
   */
  hl7Specimens(rawHl7Text: string, message: Message): { spm: any; obx: any[]; message: Message; grouped: boolean }[] {
    const specimens = message.get('SPM').toArray();
    const wholeMessage = () => specimens.map(spm => ({ spm, obx: message.get('OBX').toArray(), message, grouped: false }));
    if (specimens.length <= 1) {
      return wholeMessage();
    }

    const segments = rawHl7Text.split('\r').filter(segment => segment !== '');
    const firstSpecimen = segments.findIndex(segment => segment.startsWith('SPM|'));
    const firstResult = segments.findIndex(segment => segment.startsWith('OBX|'));
    if (firstSpecimen === -1 || (firstResult !== -1 && firstResult < firstSpecimen)) {
      return wholeMessage();
    }

    const header = segments.slice(0, firstSpecimen);
    const groups: string[][] = [];
    for (const segment of segments.slice(firstSpecimen)) {
      if (segment.startsWith('SPM|')) {
        groups.push([]);
      }
      groups[groups.length - 1].push(segment);
    }

    // Specimens listed one after another with every result behind the last
    // of them do not own the segments that follow them: read as a whole.
    const hasResults = (group: string[]) => group.some(segment => segment.startsWith('OBX|'));
    if (groups.slice(0, -1).every(group => !hasResults(group))) {
      return wholeMessage();
    }

    return groups.map(group => {
      // A header OBR describes no specimen in particular; a specimen's own
      // OBR, when it has one, is the one its test type is read from.
      const ownOrder = group.some(segment => segment.startsWith('OBR|'));
      const specimenHeader = ownOrder ? header.filter(segment => !segment.startsWith('OBR|')) : header;
      const specimenMessage = this.createHL7Message([...specimenHeader, ...group].join('\r'));
      return {
        spm: specimenMessage.get('SPM').toArray()[0],
        obx: specimenMessage.get('OBX').toArray(),
        message: specimenMessage,
        grouped: true
      };
    });
  }

  /**
   * Extracts message ID and other key parameters from an HL7 message
   * @param message HL7 message object
   * @returns Object containing extracted parameters
   */
  extractHL7MessageParams(message: any): { msgID: string, characterSet: string, messageProfileIdentifier: string, hl7Version: string } {
    return {
      msgID: message.get('MSH.10')?.toString() ?? '',
      characterSet: message.get('MSH.18')?.toString() ?? 'UNICODE UTF-8',
      messageProfileIdentifier: message.get('MSH.21')?.toString() ?? '',
      hl7Version: message.get('MSH.12')?.toString() ?? '2.5.1'
    };
  }

  /**
   * Validates if an HL7 message contains required segments
   * @param message HL7 message to validate
   * @returns Boolean indicating if message is valid
   */
  isValidHL7Message(message: Message | null | undefined): boolean {
    // Missing paths return an EmptyNode rather than null in this parser.
    return !!message && message.exists('SPM') && message.exists('OBX');
  }

  /**
   * The message inside one MLLP block, as every parser expects it: without
   * the VT and FS framing bytes, trimmed, and with every line break written
   * as the CR that separates HL7 segments.
   *
   * Used for a block received live and for the same block read back from
   * raw data, so reprocessing parses exactly what live processing parsed.
   */
  unwrapMLLPBlock(block: string): string {
    return (block ?? '')
      .replace(/[\x0b\x1c]/g, '')
      .trim()
      .replace(/[\r\n\x0B\x0C\u0085\u2028\u2029]+/gm, '\r');
  }

  /**
   * True when these bytes hold a block that is complete but for its <CR>, the
   * one case extractMLLPMessages holds back.
   * @param buffered Bytes received so far that have not been consumed
   */
  endsAtFrameSeparator(buffered: string): boolean {
    return buffered.endsWith('\x1C');
  }

  /**
   * Splits buffered MLLP bytes into complete messages.
   *
   * A block is <VT> ... <FS> <CR>. The <FS> is what marks a message complete;
   * the <VT> and trailing <CR> are tolerated when missing because some
   * analyzers omit them, and the <CR> may arrive in a later TCP chunk.
   * Bytes before a <VT> that follow an earlier block are dropped as noise.
   *
   * When the bytes end at the <FS>, the block is held back rather than
   * returned: its <CR> may be in the chunk still to come, and a block emitted
   * without it is stored as something other than what the analyzer sent. The
   * caller decides how long to wait — `awaitTerminator: false` takes the block
   * as it stands, which is what an analyzer that omits the <CR> needs.
   * @param buffered Bytes received so far that have not been consumed
   * @param awaitTerminator Hold a block whose <CR> could still arrive
   * @returns Each complete block (with its own framing bytes) and the unconsumed tail
   */
  extractMLLPMessages(buffered: string, awaitTerminator = false): { messages: string[]; remainder: string } {
    const VT = '\x0B';
    const FS = '\x1C';
    const messages: string[] = [];
    let buffer = buffered.replace(/^[\r\n]+/, '');

    for (;;) {
      const fsIndex = buffer.indexOf(FS);
      if (fsIndex === -1) {
        break;
      }

      // Nothing after the <FS> yet: the <CR> may be in the next chunk.
      if (awaitTerminator && fsIndex === buffer.length - 1) {
        break;
      }

      let block = buffer.slice(0, fsIndex + 1);
      const vtIndex = block.indexOf(VT);
      if (vtIndex > 0) {
        block = block.slice(vtIndex);
      }

      let end = fsIndex + 1;
      if (buffer.charAt(end) === '\r') {
        end++;
        block += '\r';
      }

      messages.push(block);
      buffer = buffer.slice(end).replace(/^[\r\n]+/, '');
    }

    return { messages, remainder: buffer };
  }

  /**
   * Processes HL7 raw text by cleaning control characters
   * @param rawText Raw HL7 text to process
   * @returns Cleaned HL7 text
   */
  cleanHL7RawText(rawText: string): string {
    // Remove specific control characters
    let cleaned = rawText.replace(/[\x0b\x1c]/g, '');
    cleaned = cleaned.replace(/<SB>|<EB>/g, '');

    // Trim white space
    cleaned = cleaned.trim();
    // Normalize all line breaks to CR
    cleaned = cleaned.replace(/[\r\n\x0B\x0C\u0085\u2028\u2029]+/gm, '\r');

    return cleaned;
  }
}
