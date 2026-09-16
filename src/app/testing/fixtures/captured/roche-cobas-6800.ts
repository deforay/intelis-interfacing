/**
 * Roche cobas 6800/8800, HL7 v2.5 OUL^R22 over MLLP, as captured from a
 * production laboratory (20,000 messages). Identifiers, UUIDs and
 * dates are replaced; segments, fields and flags are as transmitted.
 *
 * What the capture showed:
 * - HL7 2.5 with character set ASCII. Several blocks often share a chunk.
 * - SPM.1 is empty; SPM.2 is the plain sample ID with no &ROCHE suffix.
 * - Four OBX per sample. OBX.1 (HIV^HIV^99ROC, OBX.4 empty) carries the
 *   quantitative value as a three-digit mantissa with a UCUM power-of-ten
 *   unit, e.g. 763 with "10*-1.{Copies}/mL", stored as sent, or
 *   "ValueNotSet" with a flag in OBX.8 (ND, BT, RR, NR). OBX.2 is NA with Ct
 *   values. OBX.3 (1/1) is ValueNotSet. OBX.4 (1/2) is the textual outcome:
 *   "Titer", "Target Not Detected", "< Titer min" or "Invalid".
 * - Mantissas run 100 to 999 for every exponent from 10*-1 to 10*4.
 * - An invalid run has OBX.2 empty, flags such as P02T, and OBX.11 = X.
 * - The analyzer also sends QBP^Q11 work-order queries.
 */
import { CR } from '../../wire-harness';

export const COBAS_6800_RESULT_TIME = '20260308121433';
export const COBAS_6800_RESULT_TIME_FORMATTED = '2026-03-08 12:14:33';
export const COBAS_6800_OPERATOR = 'Lyneldra';
const DEVICE = 'C6800/8800^Roche^^~Unknown^Roche^^~ID_000000000000000001^IM300-000001^^';
const CONTROLS = '592_neg^^99ROC~591_pos^^99ROC';

function msh(messageId: string, type: string): string {
  return `MSH|^~\\&|COBAS6800/8800||LIS||20260308152752||${type}|${messageId}|P|2.5||||||ASCII`;
}

function obx(setId: number, type: string, identifier: string, subId: string, value: string, unit: string, flag: string, status: string): string {
  return `OBX|${setId}|${type}|${identifier}|${subId}|${value}|${unit}||${flag}|||${status}|||||${COBAS_6800_OPERATOR}||${DEVICE}|${COBAS_6800_RESULT_TIME}|||||||||${CONTROLS}`;
}

function envelope(messageId: string, sampleId: string, observations: string[]): string {
  return [
    msh(messageId, 'OUL^R22'),
    `SPM||${sampleId}||PLAS^plasma^HL70487|||||||P||||||||||||||||`,
    'SAC|||||||||||||||||||||500|||uL^^UCUM',
    'OBR|1|||70241-5^HIV^LN|||||||A',
    observations[0],
    'TCD|70241-5^HIV^LN|^1^:^0',
    ...observations.slice(1),
    'TCD|70241-5^HIV^LN|^1^:^0'
  ].join(CR);
}

export function cobas6800Quantified(messageId: string, sampleId: string, mantissa: string, exponent: number): string {
  return envelope(messageId, sampleId, [
    obx(1, 'NM', 'HIV^HIV^99ROC', '', mantissa, `10*${exponent}.{Copies}/mL^^UCUM`, '', 'F'),
    obx(2, 'NA', 'HIV^HIV^99ROC^S_OTHER^Other Supplemental^IHELAW', '', '36.51^^37.15', '', '', 'F'),
    obx(3, 'ST', '70241-5^HIV^LN', '1/1', 'ValueNotSet', '', 'RR', 'F'),
    obx(4, 'ST', '70241-5^HIV^LN', '1/2', 'Titer', '', '""', 'F')
  ]);
}

export function cobas6800Outcome(messageId: string, sampleId: string, outcome: 'Target Not Detected' | '< Titer min', flag: 'ND' | 'BT'): string {
  return envelope(messageId, sampleId, [
    obx(1, 'ST', 'HIV^HIV^99ROC', '', 'ValueNotSet', '', flag, 'F'),
    obx(2, 'NA', 'HIV^HIV^99ROC^S_OTHER^Other Supplemental^IHELAW', '', '^^37.68', '', '', 'F'),
    obx(3, 'ST', '70241-5^HIV^LN', '1/1', 'ValueNotSet', '', flag === 'ND' ? 'NR' : 'RR', 'F'),
    obx(4, 'ST', '70241-5^HIV^LN', '1/2', outcome, '', '""', 'F')
  ]);
}

export function cobas6800Invalid(messageId: string, sampleId: string): string {
  return envelope(messageId, sampleId, [
    obx(1, '', 'HIV^HIV^99ROC', '', '', '', 'P02T', 'X'),
    obx(2, '', '70241-5^HIV^LN', '1/1', '', '', 'P02T~P01T~C02H1', 'X'),
    obx(3, 'ST', '70241-5^HIV^LN', '1/2', 'Invalid', '', '""', 'X')
  ]);
}

export function cobas6800Query(messageId: string, sampleId: string): string {
  return [msh(messageId, 'QBP^Q11'), `QPD|WOS^Work Order Step^IHE_LABTF||${sampleId}|||`].join(CR);
}

export const COBAS_6800_CAPTURE: string[] = [
  cobas6800Quantified('MSG-6800-01', 'WB26-02146', '763', -1),
  cobas6800Quantified('MSG-6800-02', 'BP26-15201', '194', 0),
  cobas6800Quantified('MSG-6800-03', 'BP26-15202', '226', 4),
  cobas6800Outcome('MSG-6800-04', 'WB26-02135', 'Target Not Detected', 'ND'),
  cobas6800Outcome('MSG-6800-05', 'BP26-15178', '< Titer min', 'BT'),
  cobas6800Invalid('MSG-6800-06', 'BP26-16850')
];
