/**
 * Roche cobas 5800 via the X800 Data Manager, HL7 v2.5.1 OUL^R22 over MLLP,
 * as captured from a production laboratory. Identifiers, UUIDs and dates are
 * replaced; every segment, field and flag is as transmitted.
 *
 * What the capture showed:
 * - One message per sample, each in its own MLLP block.
 * - SPM.2 is "<id>&ROCHE"; SAC.3 repeats the plain id.
 * - A quantitative result is OBX.2 NM with a three-digit mantissa in OBX.5
 *   and a UCUM power-of-ten unit in OBX.6, e.g. 367 with "10*-1.{copies}/mL".
 *   Both are stored as sent; the tool does not interpret them.
 * - Target not detected is OBX.2 ST, OBX.5 "Target Not Detected", OBX.6
 *   "^^UCUM", OBX.8 "ND^^99ROC".
 * - A failed sample has OBX.2 and OBX.5 empty, OBX.8 with the error code and
 *   text repeated twice, OBX.11 = X, and no operator.
 */
import { CR } from '../../wire-harness';

export const COBAS_5800_MESSAGE_TIME = '20260404131145+0100';
export const COBAS_5800_RESULT_TIME = '20260404180624';
export const COBAS_5800_RESULT_TIME_FORMATTED = '2026-04-04 18:06:24';
export const COBAS_5800_OPERATOR = 'labuser1';

function msh(messageId: string): string {
  return `MSH|^~\\&|X800 DM||HOST||${COBAS_5800_MESSAGE_TIME}||OUL^R22^OUL_R22|${messageId}|P|2.5.1|||NE|AL||UNICODE UTF-8|||LAB-29^IHE`;
}

function envelope(messageId: string, sampleId: string, rack: string, position: number, obx: string): string {
  return [
    msh(messageId),
    `SPM|1|${sampleId}&ROCHE||PLAS^plasma^HL70487|||||||P^^HL70369`,
    `SAC|||${sampleId}|||||||${rack}|${position}`,
    'OBR||||70241-5^HIV^LN',
    'ORC|SC||||CM',
    obx
  ].join(CR);
}

const RUN = '5-2709-20260404-1526';
const DEVICE = 'c5800^Roche~c5800.2709^Roche';

export function cobas5800Quantified(messageId: string, sampleId: string, mantissa: string, exponent: number, position: number): string {
  return envelope(messageId, sampleId, 'S08', position,
    `OBX|1|NM|HIV^HIV^99ROC|1|${mantissa}|10*${exponent}.{copies}/mL^^UCUM||VAL^^99ROC|||F|||||${COBAS_5800_OPERATOR}||${DEVICE}|${COBAS_5800_RESULT_TIME}||${RUN}||||||||RSLT`);
}

export function cobas5800TargetNotDetected(messageId: string, sampleId: string, position: number): string {
  return envelope(messageId, sampleId, 'S08', position,
    `OBX|1|ST|HIV^HIV^99ROC|1|Target Not Detected|^^UCUM||ND^^99ROC|||F|||||${COBAS_5800_OPERATOR}||${DEVICE}|${COBAS_5800_RESULT_TIME}||${RUN}||||||||RSLT`);
}

export function cobas5800Failed(messageId: string, sampleId: string, code: string, text: string, position: number): string {
  const flag = `${code}^${text}^99ROC`;
  return envelope(messageId, sampleId, 'S07', position,
    `OBX|1||HIV^HIV^99ROC|1||||${flag}~${flag}|||X|||||||${DEVICE}|20260404154651||${RUN}||||||||RSLT`);
}

export const COBAS_5800_PIPETTING_ERROR = 'Pipetting anomaly detected during sample aspiration.';
export const COBAS_5800_CLOT_ERROR = 'Clot has been detected while aspirating/mixing sample in sample tube. Sample not transferred';

/** The eight messages of the capture, in the order they were received. */
export const COBAS_5800_CAPTURE: string[] = [
  cobas5800Failed('MSG-5800-01', 'VL00000407', 'U06T', COBAS_5800_PIPETTING_ERROR, 4),
  cobas5800Failed('MSG-5800-02', 'VL00000397', 'P02T', COBAS_5800_CLOT_ERROR, 10),
  cobas5800Failed('MSG-5800-03', 'VL00000671', 'P02T', COBAS_5800_CLOT_ERROR, 14),
  cobas5800Quantified('MSG-5800-04', 'VL00000427', '367', -1, 6),
  cobas5800Quantified('MSG-5800-05', 'VL00000428', '101', 0, 7),
  cobas5800Quantified('MSG-5800-06', 'VL00000429', '337', -1, 8),
  cobas5800TargetNotDetected('MSG-5800-07', 'VL00000430', 9),
  cobas5800TargetNotDetected('MSG-5800-08', 'VL00000431', 10)
];
