/**
 * Abbott Alinity m HIV-1, HL7 v2.5.1 OUL^R22 over MLLP, as captured from a
 * production laboratory (two software generations). Identifiers, UUIDs,
 * serials, operators and dates are replaced; the segment order, field
 * positions and value formats are as transmitted.
 *
 * What the capture showed:
 * - One message per sample. Newer software sends several samples' blocks in
 *   one TCP chunk, each as <VT>...<FS><CR>.
 * - SPM.2 and SPM.3 are always empty; the sample ID is in SAC.3.
 * - OBX.1 (1006^HIV-1) is the result: "Not Detected", "< 20", or a number
 *   with thousands separators such as "161,152". The unit is in the second
 *   component of OBX.6 ("^Copies/mL"), the first being empty.
 * - Sixteen INV segments and an NTE sit between OBX.1 and the supplemental
 *   OBX segments (interpretation, cycle number, run id, control readings;
 *   newer software adds a log10 value).
 * - OBX.16 holds the operator as two repetitions, a user name then a role
 *   ("TECH01~operator" here), and OBX.19 the result time.
 */
import { CR } from '../../wire-harness';

export const ALINITY_RESULT_TIME = '20260112142906';
export const ALINITY_RESULT_TIME_FORMATTED = '2026-01-12 14:29:06';
export const ALINITY_OPERATOR = 'TECH01~operator';
const DEVICE = 'Alinity m^Abbott~M00001^Abbott~1^Abbott~11^Abbott';

export interface AlinitySample {
  messageId: string;
  sampleId: string;
  /** "Not Detected", "< 20", or a number as the analyzer prints it */
  result: string;
  /** Newer software adds a log10 OBX and reports "Detected <LLOQ" */
  newerSoftware?: boolean;
}

const INVENTORY = [
  'INV|1006^^99ABT|NA^Not applicable^HL70383|CA^Calibration^99ABT||||||||||20251202144858|||399444',
  'INV|HIV-1 CAL A^^99ABT|NA^Not applicable^HL70383|RC^Reagent Calibrator^HL70384|004568^^99ABT||||||||20260131||||399079',
  'INV|HIV-1 CAL A^^99ABT|NA^Not applicable^HL70383|RC^Reagent Calibrator^HL70384|004549^^99ABT||||||||20260131||||399079',
  'INV|HIV-1 CAL B^^99ABT|NA^Not applicable^HL70383|RC^Reagent Calibrator^HL70384|003993^^99ABT||||||||20260131||||399074',
  'INV|HIV-1 CAL B^^99ABT|NA^Not applicable^HL70383|RC^Reagent Calibrator^HL70384|003998^^99ABT||||||||20260131||||399074',
  'INV|HIV-1 NEG CTRL^^99ABT|NA^Not applicable^HL70383|CO^Assay Control^HL70384|006539^^99ABT||||||||20260507||||403055',
  'INV|HIV-1 LOW POS CTRL^^99ABT|NA^Not applicable^HL70383|CO^Assay Control^HL70384|012677^^99ABT||||||||20260507||||403051',
  'INV|HIV-1 HIGH POS CTRL^^99ABT|NA^Not applicable^HL70383|CO^Assay Control^HL70384|013713^^99ABT||||||||20260507||||403049',
  'INV|3001-AMP_KIT_REAGENT^^99ABT|NA^Not applicable^HL70383|SR^Single Test Reagent^HL70384|03117^^99ABT||||||||20261128||||397813',
  'INV|3002-AMP_KIT_REAGENT^^99ABT|NA^Not applicable^HL70383|SR^Single Test Reagent^HL70384|00020^^99ABT||||||||20261128||||397813',
  'INV|200-SAMPLE_PREP_REAGENT^^99ABT|NA^Not applicable^HL70383|SR^Single Test Reagent^HL70384|02878^^99ABT||||||||20261114||||397315',
  'INV|200-SAMPLE_PREP_REAGENT^^99ABT|NA^Not applicable^HL70383|SR^Single Test Reagent^HL70384|52776^^99ABT||||||||20261114||||397315',
  'INV|LYSIS^^99ABT|NA^Not applicable^HL70383|LI^Measurable Liquid Item^HL70384|||||||||20261214||||990020082',
  'INV|DILUENT^^99ABT|NA^Not applicable^HL70383|LI^Measurable Liquid Item^HL70384|||||||||20261211||||990020079',
  'INV|VAPOR_BARRIER^^99ABT|NA^Not applicable^HL70383|LI^Measurable Liquid Item^HL70384|||||||||20260912||||2471611',
  'INV|IRU^^99ABT|NA^Not applicable^HL70383|SC^Countable Solid Item^HL70384|||||||||||||2880564'
];

function obx(setId: number, type: string, identifier: string, subId: string, value: string, unit: string): string {
  return `OBX|${setId}|${type}|${identifier}|${subId}|${value}|${unit}||""|||F|||||${ALINITY_OPERATOR}||${DEVICE}|${ALINITY_RESULT_TIME}||||||||||RSLT`;
}

export function alinityMessage(sample: AlinitySample): string {
  const notDetected = sample.result === 'Not Detected';
  const belowRange = sample.result === '< 20';
  const byOutcome = (ifNotDetected: string, ifBelowRange: string, ifDetected: string): string => {
    if (notDetected) return ifNotDetected;
    return belowRange ? ifBelowRange : ifDetected;
  };
  const interpretation = byOutcome('Target Not Detected', 'Detected <LLOQ', 'Detected');
  const cycle = byOutcome('-1.00', '27.03', '18.62');
  const unit = notDetected ? '' : '^Copies/mL';
  const supplemental = '^S_OTHER^Other Supplemental^IHELAW';
  const segments = [
    String.raw`MSH|^~\&|||||20260112150335+0100||OUL^R22^OUL_R22|${sample.messageId}|P|2.5.1|||NE|AL||UNICODE UTF-8|||LAB-29^IHE`,
    'SPM|1|||PLAS^Plasma^HL70487|||||||P^Patient^HL70369',
    `SAC|||${sample.sampleId}|||||||A000001|7||||2^Position^99ABT`,
    'OBR||""||1006^HIV-1^99ABT',
    'ORC|SC||||CM',
    'TQ1|||||||||R^Routine^HL70485',
    obx(1, 'ST', '1006^HIV-1^99ABT', '', sample.result, unit),
    ...INVENTORY,
    'NTE|1|Z|Routine3' + ' '.repeat(150),
    obx(2, 'ST', '1006.I^HIV-1^99ABT', '', interpretation, ''),
    obx(3, 'NM', `1006.R^HIV-1^99ABT${supplemental}`, 'HIV-1', cycle, '^CN'),
    obx(4, 'EI', `1006.G^HIV-1^99ABT${supplemental}`, '', '11263ee8-274f-48b7-a5e8-000000000001', '')
  ];
  let next = 5;
  if (sample.newerSoftware) {
    const log = byOutcome('Not Detected', '< 1.30', '4.21');
    segments.push(obx(next++, 'ST', `1006.S^HIV-1^99ABT${supplemental}`, '0', log, '^Log (Copies/mL)'));
  }
  segments.push(
    obx(next++, 'NM', `1006.M^HIV-1^99ABT${supplemental}`, 'IC', '0.361', ''),
    obx(next++, 'NM', `1006.M^HIV-1^99ABT${supplemental}`, 'HIV-1', notDetected ? '0.002' : '0.296', ''),
    obx(next++, 'NM', `1006.C^HIV-1^99ABT${supplemental}`, 'IC', '15.70', '^CN')
  );
  return segments.join(CR);
}

export const ALINITY_NOT_DETECTED: AlinitySample = { messageId: 'MSG-ALM-001', sampleId: 'VL00000101', result: 'Not Detected' };
export const ALINITY_BELOW_RANGE: AlinitySample = { messageId: 'MSG-ALM-002', sampleId: 'VL00000102', result: '< 20', newerSoftware: true };
export const ALINITY_QUANTIFIED: AlinitySample = { messageId: 'MSG-ALM-003', sampleId: 'VL00000103', result: '161,152', newerSoftware: true };
export const ALINITY_QUANTIFIED_SMALL: AlinitySample = { messageId: 'MSG-ALM-004', sampleId: 'VL00000104', result: '32', newerSoftware: true };
export const ALINITY_NOT_DETECTED_NEWER: AlinitySample = { messageId: 'MSG-ALM-005', sampleId: 'VL00000105', result: 'Not Detected', newerSoftware: true };

/** The five samples newer software sends together in one chunk. */
export const ALINITY_BATCH: AlinitySample[] = [
  ALINITY_BELOW_RANGE, ALINITY_QUANTIFIED, ALINITY_QUANTIFIED_SMALL, ALINITY_NOT_DETECTED_NEWER,
  { messageId: 'MSG-ALM-006', sampleId: 'VL00000106', result: '3,512', newerSoftware: true }
];
