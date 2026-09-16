/**
 * Roche cobas 4800 (software 2.3.0.1905), HL7 v2.5.1 OUL^R22 over MLLP, as
 * captured from two laboratories in the DRC. Identifiers, UUIDs and dates are
 * replaced; segments, fields and value formats are as transmitted.
 *
 * What the capture showed:
 * - One message per run carrying every sample: 12 to 51 SPM groups.
 * - Each group is SPM, SAC, INV, OBR, ORC, two OBX, two INV, three NTE.
 *   The first OBX is a DR RunTimeRange (OBX.4 = 1.0); the second (OBX.4 =
 *   1.1) is the result: "3.26E+05 cp/mL" with unit "1/mL^^UCUM", or
 *   "Target Not Detected", "< Titer min", "Invalid" with no unit.
 * - SPM.2 is "<id>&ROCHE"; controls carry INV segments naming them.
 * - The analyzer also sends QBP^Q11 work-order queries.
 *
 * A third laboratory (same software, 842 transmissions over 19 months) adds:
 * - OBX.11 is F, X for a failed run, or P. P is not a draft: nearly every
 *   sample reported P was never sent again as F. Every HL7 result is stored
 *   as final, which is what lets these reach the LIS at all.
 * - "Failed" in OBX.5 with OBX.11 X, and flag codes in NTE 1 ("F;X2,X3",
 *   "F;M1,X2", "F;R3223,X2" on an Invalid). Notes are empty today: the flag
 *   codes are not kept, which is open.
 * - "> Titer max", stored as "> 10000000" by a mapping in the HL7 helper,
 *   which is open too: it writes a number the analyzer did not send.
 * - A qualitative assay, OBX.3 "0BHIV1QUAL", reporting "Not Detected",
 *   "Detected", and "Valid" on its control.
 * - A control can fail with no identifier at all: SPM.2 "&ROCHE", SAC.3
 *   empty. The sample ID is stored empty, never inferred.
 */
import { CR } from '../../wire-harness';

export const COBAS_4800_RESULT_TIME = '20260612194324';
export const COBAS_4800_RESULT_TIME_FORMATTED = '2026-06-12 19:43:24';
export const COBAS_4800_OPERATOR = 'Laboperator01';
const DEVICE = 'C4800^Roche~56450_00001^Roche';

export interface Cobas4800Sample {
  sampleId: string;
  /** "3.26E+05 cp/mL", "Target Not Detected", "< Titer min", "Invalid", "Failed" */
  value: string;
  control?: string;
  /** OBX.3 assay code. Defaults to the quantitative "0BHIV1". */
  assay?: string;
  /** OBX.11: F, P or X. Defaults to F. */
  status?: 'F' | 'P' | 'X';
  /** NTE 1 flags. Defaults to "F;NONE". */
  flags?: string;
}

function sampleGroup(index: number, sample: Cobas4800Sample): string[] {
  const unit = /cp\/mL$/.test(sample.value) ? '1/mL^^UCUM' : '';
  const assay = sample.assay ?? '0BHIV1';
  return [
    `SPM|${index}|${sample.sampleId}&ROCHE||""|||||||Q^^HL70369`,
    `SAC|||${sample.sampleId}`,
    ...(sample.control ? [`INV|${sample.control}^^99ROC|OK^^HL70383|CO^^HL70384`] : []),
    `OBR||""||${assay}^${assay}^99ROC||20260612162143`,
    'ORC|SC||||CM',
    `OBX|1|DR|RunTimeRange^Run Execution Time Range^99ROC^S_OTHER^Other_Supplemental^IHELAW|1.0|20260612163740^20260612194324|||""|||F|||||${COBAS_4800_OPERATOR}||${DEVICE}|${COBAS_4800_RESULT_TIME}`,
    `OBX|2|ST|${assay}^${assay}^99ROC|1.1|${sample.value}|${unit}||Full^^99ROC|||${sample.status ?? 'F'}|||||${COBAS_4800_OPERATOR}||${DEVICE}|${COBAS_4800_RESULT_TIME}`,
    'INV|""|OK^^HL70383|OT^^HL70384|MwpId^^99ROC|OE3951553^^99ROC|A01^^99ROC',
    'INV|""|OK^^HL70383|OT^^HL70384|DwpId^^99ROC|OG5803744^^99ROC',
    `NTE|1||${sample.flags ?? 'F;NONE'}`,
    `NTE|2||Ct:0 (MMx 1),${sample.status === 'X' ? 'N/A' : '26.71'}`,
    'NTE|3||'
  ];
}

export function cobas4800Run(messageId: string, samples: Cobas4800Sample[]): string {
  return [
    `MSH|^~\\&|cobas 4800 software 2.3.0.1905^56450_00001^M|INRB Biomol LAB|LIS|LIS Facility|20260613145247+0100||OUL^R22^OUL_R22|${messageId}|P|2.5.1|||ER|AL||UNICODE UTF-8|||LAB-29^IHE`,
    ...samples.flatMap((sample, index) => sampleGroup(index + 1, sample))
  ].join(CR);
}

export function cobas4800Query(messageId: string, sampleId: string): string {
  return [
    `MSH|^~\\&|cobas 4800 software 2.3.0.1905|INRB Biomol LAB|LIS|LIS Facility|20260613120846+0100||QBP^Q11^QBP_Q11|${messageId}|P|2.5.1|||ER|AL||UNICODE UTF-8|||LAB-27^IHE`,
    `QPD|WOS^Work Order Step^IHELAW|${messageId}-WOS|${sampleId}`,
    'RCP|I||R^^HL70394'
  ].join(CR);
}

export const COBAS_4800_RUN: Cobas4800Sample[] = [
  { sampleId: '0PHJ100001N0QVJ', value: '3.26E+05 cp/mL', control: 'HPosCtrl' },
  { sampleId: '0PLJ100002N07UX', value: '2.46E+02 cp/mL', control: 'LPosCtrl' },
  { sampleId: '0N1J100003O0OEZ', value: 'Target Not Detected', control: 'NEGCONTROL' },
  { sampleId: 'VL260001', value: 'Target Not Detected' },
  { sampleId: 'VL260002', value: '< Titer min' },
  { sampleId: 'VL260003', value: '6.73E+01 cp/mL' },
  { sampleId: 'VL260004', value: 'Invalid' },
  { sampleId: 'VL260005', value: '1.70E+05 cp/mL' }
];

/** Outcomes the third laboratory sends that the first two did not. */
export const COBAS_4800_THIRD_LAB_RUN: Cobas4800Sample[] = [
  { sampleId: 'VL230101', value: '4.12E+03 cp/mL', status: 'P', flags: 'F;X1' },
  { sampleId: 'VL230102', value: 'Target Not Detected', status: 'P', flags: 'F;X1' },
  { sampleId: 'VL230103', value: 'Failed', status: 'X', flags: 'F;X2,X3' },
  { sampleId: 'VL230104', value: 'Failed', status: 'X', flags: 'F;M1,X2' },
  { sampleId: 'VL230105', value: 'Invalid', flags: 'F;R3223,X2' },
  { sampleId: 'VL230106', value: '> Titer max', flags: 'F;X1' },
  { sampleId: 'EID230107', value: 'Not Detected', assay: '0BHIV1QUAL', flags: 'F;X1' },
  { sampleId: 'EID230108', value: 'Detected', assay: '0BHIV1QUAL', flags: 'F;X1' },
  { sampleId: '0PLJ230109N0AUQ', value: 'Valid', assay: '0BHIV1QUAL', control: 'POSCONTROL' },
  { sampleId: '', value: 'Failed', status: 'X', flags: 'F;X1', control: 'HPosCtrl' }
];
