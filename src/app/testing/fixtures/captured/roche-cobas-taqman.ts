/**
 * Roche COBAS AmpliPrep/COBAS TaqMan 96 through AMPLILINK 3.3, from two
 * production laboratories' logs: AMPLILINK 3.3.5 (2012) and 3.3.7 (2018),
 * both "Roche ASTM+". Sample IDs, instrument serials, addresses, operator and
 * laboratory names and dates are replaced; every record, field position and
 * value format is as logged.
 *
 * Field numbers count the record type as field 1, as docs/technical/analyzers.md
 * does.
 *
 * What the logs showed:
 * - One message per sample: H P O R C.. L, records separated by CR, no ETB.
 *   A session can carry a whole batch of these messages.
 * - R.4 is the result exactly as the software wrote it, and the format
 *   depends on the AMPLILINK version: 3.3.5 prints a mantissa with its log
 *   value in brackets, "2.52E+3 (3.40)", with unit "cp/mL"; 3.3.7 sends the
 *   unrounded number, "1035.95864507225", with unit "cp/ml". "Target Not
 *   Detected" has an empty unit in both.
 * - Sample IDs are free text and keep what the operator typed, double spaces
 *   included.
 * - The C records carry the result's acceptance ("Accepted") and the
 *   instrument flags, e.g. "TM40^ STEP_CORR-2". Notes keep the text of each
 *   and drop the flag code.
 * - The order record stops at O.12, so there is no O.26 report type, which is
 *   where the final status is read from: results are stored as not final. The
 *   result itself is marked "V" (verified) in R.9, which nothing reads.
 * - O.5 names the test as "^^^ALL"; the assay code, "HI2CAP96", is only in R.3.
 *
 * What the logs could not show: the framing. They hold records only. An
 * AMPLILINK host-interface simulator trace from the same project shows
 * standard E1381 frames with checksums; the laboratory configuration is
 * remembered as sending none. Both framings are built here.
 *
 * Open, and pinned as they are until a TaqMan laboratory says what its LIS
 * expects: whether a TaqMan result should be stored as final (for example by
 * reading R.9 when O.26 is absent), and whether the test type should be the
 * assay code from R.3 rather than "ALL" from the order.
 */
import { CR, EOT, ENQ, ETX, LF, STX, astmFrames } from '../../wire-harness';

export const TAQMAN_LAB = 'VL-LAB';
export const TAQMAN_COMPLETED_TIME_FORMATTED = '2026-03-10 20:54:15';

export interface TaqmanSample {
  version: '3.3.5.1002' | '3.3.7.1201';
  sampleId: string;
  result: string;
  unit: string;
  flags: string[];
}

const NOT_DETECTED_FLAGS = ['TM40^ STEP_CORR-2', 'TM49^ RFITOOLOW-1'];

export const TAQMAN_SAMPLES: TaqmanSample[] = [
  { version: '3.3.5.1002', sampleId: 'TM-0001/26', result: 'Target Not Detected', unit: '', flags: NOT_DETECTED_FLAGS },
  { version: '3.3.5.1002', sampleId: 'TM-0002/26', result: '2.52E+3 (3.40)', unit: 'cp/mL', flags: ['TM40^ STEP_CORR-2', 'TM42^ SPK_CORR-2'] },
  { version: '3.3.7.1201', sampleId: 'QC 1', result: '1035.95864507225', unit: 'cp/ml', flags: ['TM40^ STEP_CORR-2'] },
  { version: '3.3.7.1201', sampleId: 'QC 2', result: '58.9827777398403', unit: 'cp/ml', flags: ['TM40^ STEP_CORR-2'] },
  { version: '3.3.7.1201', sampleId: 'QC  20', result: 'Target Not Detected', unit: '', flags: NOT_DETECTED_FLAGS }
];

/** The H..L message for one sample, one record per entry. */
export function taqmanMessage(sample: TaqmanSample): string[] {
  const instrument = sample.version === '3.3.5.1002' ? 'Taqman96' : 'Cobas TaqMan';
  return [
    `H|\\^&|||ALTM0000001^Roche^AMPLILINK^${sample.version}^Roche ASTM+^TM0000001^192.0.2.10||||||||1|20260314090241`,
    'P|1',
    `O|1|${sample.sampleId}|${sample.sampleId}|^^^ALL||20260310125523|||||A`,
    `R|1|^^^HI2CAP96|${sample.result}|${sample.unit}|20^10000000^TiterRanges|N||V||${TAQMAN_LAB}|20260310175015|20260310205415|${instrument}`,
    'C|1||Accepted|G',
    ...sample.flags.map((flag, index) => `C|${index + 2}|I|${flag}|I`),
    'L|1|N'
  ];
}

export type TaqmanFraming = 'checksum' | 'no-checksum';

/** One E1381 frame per record, frame numbers running on across messages. */
export function taqmanFrames(messages: string[][], framing: TaqmanFraming): string[] {
  const records = messages.flat();
  return framing === 'checksum'
    ? astmFrames(records)
    : records.map((record, index) => STX + ((index + 1) % 8) + record + CR + ETX + CR + LF);
}

/** A batch of samples as one E1381 session. */
export function taqmanSession(samples: TaqmanSample[], framing: TaqmanFraming): string {
  return ENQ + taqmanFrames(samples.map(taqmanMessage), framing).join('') + EOT;
}
