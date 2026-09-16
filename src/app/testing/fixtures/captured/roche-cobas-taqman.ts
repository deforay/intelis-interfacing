/**
 * Roche COBAS AmpliPrep/COBAS TaqMan 96 through AMPLILINK 3.3, as logged by
 * a production laboratory (AMPLILINK 3.3.5, "Roche ASTM+"). Sample IDs, the
 * instrument serial, its address, the laboratory name and dates are
 * replaced; every record, field position and value format is as logged.
 *
 * What the log showed, and what it could not:
 * - One message per sample: H P O R C C C L, records separated by CR, no
 *   ETB. The log holds the records only, not the bytes on the wire, so the
 *   framing here is reconstructed. TaqMan sends no checksums, so frames are
 *   STX, frame number, record, CR, ETX, CR LF.
 * - R.3 is the result exactly as printed: "Target Not Detected", or a
 *   mantissa with its log value in brackets, "2.52E+3 (3.40)". R.4 is the
 *   unit, "cp/mL", and is empty when no target was detected. R.5 carries
 *   the titer range, "20^10000000^TiterRanges".
 * - The C records carry the result's acceptance ("Accepted") and the
 *   instrument flags, e.g. "TM40^ STEP_CORR-2".
 * - R.8, the result status, is "V" (verified), not "F". O.4 names the test
 *   as "^^^ALL"; the assay code, "HI2CAP96", is only in R.2.
 *
 * Open, and pinned as they are until a TaqMan laboratory says what its LIS
 * expects: whether "V" should count as a final result (it is stored as not
 * final today), and whether the test type should be the assay code from R.2
 * rather than "ALL" from the order.
 */
import { CR, EOT, ENQ, ETX, LF, STX } from '../../wire-harness';

export const TAQMAN_HEADER_PREFIX = 'H|\\^&|||ALTM0000001^Roche^AMPLILINK^3.3.5.1002^Roche ASTM+^TM0000001^192.0.2.10||||||||1|';
export const TAQMAN_LAB = 'VL-LAB';
export const TAQMAN_COMPLETED_TIME_FORMATTED = '2026-03-10 20:54:15';

export interface TaqmanSample {
  sampleId: string;
  result: string;
  unit: string;
  flags: string[];
}

export const TAQMAN_SAMPLES: TaqmanSample[] = [
  { sampleId: 'TM-0001/26', result: 'Target Not Detected', unit: '', flags: ['TM40^ STEP_CORR-2', 'TM49^ RFITOOLOW-1'] },
  { sampleId: 'TM-0002/26', result: 'Target Not Detected', unit: '', flags: ['TM40^ STEP_CORR-2', 'TM49^ RFITOOLOW-1'] },
  { sampleId: 'TM-0003/26', result: 'Target Not Detected', unit: '', flags: ['TM40^ STEP_CORR-2', 'TM49^ RFITOOLOW-1'] },
  { sampleId: 'TM-0004/26', result: '2.52E+3 (3.40)', unit: 'cp/mL', flags: ['TM40^ STEP_CORR-2', 'TM42^ SPK_CORR-2'] }
];

/** The H..L message for one sample, one record per entry. */
export function taqmanMessage(sample: TaqmanSample, sentAt = '20260314090241'): string[] {
  return [
    TAQMAN_HEADER_PREFIX + sentAt,
    'P|1',
    `O|1|${sample.sampleId}|${sample.sampleId}|^^^ALL||20260310125523|||||A`,
    `R|1|^^^HI2CAP96|${sample.result}|${sample.unit}|20^10000000^TiterRanges|N||V||${TAQMAN_LAB}|20260310175015|20260310205415|Taqman96`,
    'C|1||Accepted|G',
    ...sample.flags.map((flag, index) => `C|${index + 2}|I|${flag}|I`),
    'L|1|N'
  ];
}

/** One E1381 frame per record, without a checksum. */
export function taqmanFrames(records: string[], firstFrameNumber = 1): string[] {
  return records.map((record, index) => STX + ((firstFrameNumber + index) % 8) + record + CR + ETX + CR + LF);
}

/** One sample as one E1381 session. */
export function taqmanSession(sample: TaqmanSample): string {
  return ENQ + taqmanFrames(taqmanMessage(sample)).join('') + EOT;
}
