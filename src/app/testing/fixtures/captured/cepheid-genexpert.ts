/**
 * Cepheid GeneXpert (software 5.3 and 6.2), ASTM E1394 over E1381, as
 * captured from production laboratories. Identifiers,
 * operators and dates are replaced; record layouts, value formats and the
 * framing are as transmitted.
 *
 * What the capture showed:
 * - The H record declares the delimiters as "@^\" rather than "\^&".
 * - One message per test, each in its own session (ENQ ... EOT).
 * - Frames are filled to 240 bytes and cut wherever that falls, so records
 *   are split across ETB continuation frames, often mid-field.
 * - O.3 is whatever the operator typed as the sample ID, sometimes a
 *   patient name. O.5 is "^^^<assay>". O.26 is F.
 * - R.1 is the assay result with a trailing component separator:
 *   "NOT DETECTED^", "DETECTED^", "ERROR^", "INVALID^". For viral load the
 *   number sits in the second component ("^1234.56"), R.5 is copies/mL and
 *   R.6 the reportable range. R.11 is the operator, R.13 the end time.
 * - Further R records carry analyte, Ct and endpoint details; a C record
 *   explains an error as "Error^code^title^description^timestamp".
 */
import { CR, EOT, ENQ, astmFrame } from '../../wire-harness';

export const GENEXPERT_OPERATOR = 'ALBERT MUDUNGWE';
export const GENEXPERT_START_TIME = '20260129114918';
export const GENEXPERT_END_TIME = '20260129115359';
export const GENEXPERT_END_TIME_FORMATTED = '2026-01-29 11:53:59';
const CARTRIDGE = 'Cepheid-1F21001^806911^630912^1113243530^72203^20260825';
export const GENEXPERT_HEADER = 'H|@^\\|GXM-00000000001||MOH - HARARE HOSPITAL LAB - 806911^GeneXpert^6.2|||||Harare Hospital - 80||P|1394-97|20260307161412';

export interface GeneXpertTest {
  sampleId: string;
  patientId?: string;
  assay: 'HIV-1_QUAL 2' | 'HIV-1_VL 2 2' | 'MTB-RIF_ULTRA 2';
  /** "NOT DETECTED", "DETECTED", "ERROR", "INVALID", or a viral load number */
  result: string;
  error?: { code: string; title: string; description: string };
}

function resultRecord(sequence: number, test: string, value: string, unit = '', range = ''): string {
  return `R|${sequence}|${test}|${value}|${unit}|${range}|${range ? 'A' : ''}||F||${GENEXPERT_OPERATOR}|${GENEXPERT_START_TIME}|${GENEXPERT_END_TIME}|${CARTRIDGE}|`;
}

function detail(sequence: number, test: string, value: string): string {
  return `R|${sequence}|${test}|${value}|||`;
}

export function genexpertMessage(test: GeneXpertTest): string[] {
  const records = [
    GENEXPERT_HEADER,
    `P|1|||${test.patientId ?? test.sampleId}|^^^^|||||||||||||||||||||||||||||`,
    `O|1|${test.sampleId}||^^^${test.assay}|R|${GENEXPERT_START_TIME}|||||||||ORH||||||||||F`
  ];
  const outcome = test.result;
  if (test.assay === 'HIV-1_VL 2 2') {
    const numeric = /^\d/.test(outcome);
    records.push(
      resultRecord(1, `^^^${test.assay}^Xpert_HIV-1 Viral Load^2^^`, numeric ? `^${outcome}` : `${outcome}^`, 'copies/mL', '40.00 to 10000000.00'),
      resultRecord(2, `^^^${test.assay}^Xpert_HIV-1 Viral Load^2^^LOG`, numeric ? `^${Math.log10(Number(outcome)).toFixed(2)}` : '^', 'copies/mL', '1.60 to 7.00'),
      detail(3, `^^^${test.assay}^^^HIV-1^`, numeric ? 'POS^' : 'NEG^'),
      detail(4, `^^^${test.assay}^^^HIV-1^Ct`, numeric ? '^26.4' : '^0.0'),
      detail(5, `^^^${test.assay}^^^HIV-1^EndPt`, numeric ? '^312.0' : '^-7.0'),
      detail(6, `^^^${test.assay}^^^HIV-1^Delta Ct`, '^'),
      detail(7, `^^^${test.assay}^^^IQS-H^`, 'PASS^'),
      detail(8, `^^^${test.assay}^^^IQS-H^Ct`, '^23.7'),
      detail(9, `^^^${test.assay}^^^IQS-H^EndPt`, '^268.0'),
      detail(10, `^^^${test.assay}^^^IQS-L^`, 'PASS^'),
      detail(11, `^^^${test.assay}^^^IQS-L^Ct`, '^33.4'),
      detail(12, `^^^${test.assay}^^^IQS-L^EndPt`, '^478.0')
    );
  } else {
    const assayName = test.assay === 'MTB-RIF_ULTRA 2' ? 'Xpert MTB-RIF Ultra^4^MTB^' : 'Xpert_HIV-1 Qual^2^HIV-1^';
    const analyte = test.assay === 'MTB-RIF_ULTRA 2' ? 'MTB' : 'HIV-1';
    const failed = outcome === 'ERROR' || outcome === 'INVALID';
    records.push(resultRecord(1, `^${test.assay}^^^${assayName}`, `${outcome}^`));
    if (test.error) {
      records.push(`C|1|I|Error^${test.error.code}^${test.error.title}^${test.error.description}^${GENEXPERT_END_TIME}|N`);
    }
    records.push(
      detail(2, `^^^${test.assay}^^^SPC^`, failed ? 'NO RESULT^' : 'PASS^'),
      detail(3, `^^^${test.assay}^^^SPC^Ct`, failed ? '^0.0' : '^34.3'),
      detail(4, `^^^${test.assay}^^^SPC^EndPt`, failed ? '^0.0' : '^231.0'),
      detail(5, `^^^${test.assay}^^^${analyte}^`, failed ? 'NO RESULT^' : outcome === 'DETECTED' ? 'POS^' : 'NEG^'),
      detail(6, `^^^${test.assay}^^^${analyte}^Ct`, outcome === 'DETECTED' ? '^24.8' : '^0.0'),
      detail(7, `^^^${test.assay}^^^${analyte}^EndPt`, outcome === 'DETECTED' ? '^446.0' : '^0.0'),
      resultRecord(8, `^${test.assay}^^^${assayName.replace(/\^[^^]*\^$/, '^QC^')}`, failed ? `${outcome}^` : '^')
    );
    if (test.error) {
      records.push(`C|1|I|Error^${test.error.code}^${test.error.title}^${test.error.description}^${GENEXPERT_END_TIME}|N`);
    }
    records.push(
      detail(9, `^^^${test.assay}^^^QC-1^`, failed ? 'NO RESULT^' : 'NEG^'),
      detail(10, `^^^${test.assay}^^^QC-1^Ct`, '^0.0'),
      detail(11, `^^^${test.assay}^^^QC-1^EndPt`, '^0.0'),
      detail(12, `^^^${test.assay}^^^QC-2^`, failed ? 'NO RESULT^' : 'NEG^'),
      detail(13, `^^^${test.assay}^^^QC-2^Ct`, '^0.0'),
      detail(14, `^^^${test.assay}^^^QC-2^EndPt`, '^0.0')
    );
  }
  records.push('L|1|N');
  return records;
}

/**
 * Frames a message the way the GeneXpert does: the records, each ending in
 * CR, form one stream cut into 240-byte bodies. Every frame but the last ends
 * in ETB; the last ends in ETX.
 */
export function genexpertFrames(records: string[], maxBody = 240): string[] {
  const stream = records.map(record => record + CR).join('');
  const frames: string[] = [];
  for (let offset = 0, frameNumber = 1; offset < stream.length; offset += maxBody, frameNumber = (frameNumber + 1) % 8) {
    const body = stream.slice(offset, offset + maxBody);
    const last = offset + maxBody >= stream.length;
    frames.push(astmFrame(frameNumber, body, { terminator: last ? 'ETX' : 'ETB' }));
  }
  return frames;
}

export function genexpertSession(test: GeneXpertTest): string {
  return ENQ + genexpertFrames(genexpertMessage(test)).join('') + EOT;
}

export const GENEXPERT_TESTS: GeneXpertTest[] = [
  { sampleId: 'EID26000576U', assay: 'HIV-1_QUAL 2', result: 'DETECTED' },
  { sampleId: 'EID26000580O', assay: 'HIV-1_QUAL 2', result: 'NOT DETECTED' },
  { sampleId: 'VALERIAH M', assay: 'HIV-1_QUAL 2', result: 'ERROR', error: { code: '2097', title: 'Operation terminated', description: 'Error 2097: Assay-Specific Termination Error #2: 46, 7, 1, 0' } },
  { sampleId: 'bp26-00064', assay: 'HIV-1_VL 2 2', result: 'NOT DETECTED' },
  { sampleId: 'bp26-00065', assay: 'HIV-1_VL 2 2', result: '1234.56' },
  { sampleId: 'sp26-00147', assay: 'MTB-RIF_ULTRA 2', result: 'NOT DETECTED' }
];

/**
 * Cepheid GeneXpert software 6.5 running in French, as captured from a
 * production laboratory. The framing is identical to the captures
 * above; what differs is everything the analyzer's locale touches.
 *
 * What this capture showed:
 * - Every result word is French: "NON DÉTECTÉ", "DÉTECTÉ", "ERREUR",
 *   "PAS DE RÉSULTAT", with "RÉUSSITE"/"NÉG"/"POS" on the control records.
 * - Numbers use a decimal comma, in the result ("60,96"), the reportable
 *   range ("40,00 to 10000000,00") and every Ct and endpoint.
 * - A viral load can come back "DÉTECTÉ" with no number at all, flagged "<"
 *   in R.7, meaning detected below the reportable range. R.5 is still
 *   copies/mL, so the unit alone does not say whether R.4 holds a number.
 * - The qualitative assay names itself in O.5 ("^^^HIV_QUALXC1") and repeats
 *   that name in R.3 ("^HIV_QUALXC1^^HIV-1^Xpert HIV-1 Qual XC DBS^1^HIV-1^").
 * - The P record is sometimes "P|1||||" with no patient identifier at all.
 * - The C record of a failed run is French and carries a no-break space
 *   before the colon: "Erreur 2096: ... n°1 : 18, 30, 0, 0".
 */
export const GENEXPERT_FR_OPERATOR = 'MUKOMBO KASONGO LAJOIE';
export const GENEXPERT_FR_START_TIME = '20260901132630';
export const GENEXPERT_FR_END_TIME = '20260901133102';
export const GENEXPERT_FR_END_TIME_FORMATTED = '2026-09-01 13:31:02';
const FR_CARTRIDGE = 'Cepheid-0F00000^800000^600000^1200000000^30000^20270321';
export const GENEXPERT_FR_HEADER = 'H|@^\\|GXM-00000000002||800000_EXAMPLE LAB_EXAMPLE REGION_EXAMPLE COUNTRY^GeneXpert^6.5|||||VLSM LIS||P|1394-97|20260901133103';

export interface GeneXpertFrTest {
  sampleId: string;
  /** P.5, as typed by the operator. Empty on the runs that send "P|1||||". */
  patientId?: string;
  assay: 'HIV-1' | 'HIV_QUALXC1';
  /** "NON DÉTECTÉ", "DÉTECTÉ", "ERREUR", "PAS DE RÉSULTAT", or a number written with a decimal comma */
  result: string;
  /** R.7 abnormal flag: "N", "A" or "<" (detected below the reportable range) */
  flag: string;
  error?: { code: string; title: string; description: string };
}

function frResultRecord(sequence: number, test: string, value: string, unit: string, range: string, flag: string): string {
  return `R|${sequence}|${test}|${value}|${unit}|${range}|${flag}||F||${GENEXPERT_FR_OPERATOR}|${GENEXPERT_FR_START_TIME}|${GENEXPERT_FR_END_TIME}|${FR_CARTRIDGE}`;
}

function frDetail(sequence: number, test: string, value: string): string {
  return `R|${sequence}|${test}|${value}|||`;
}

export function genexpertFrMessage(test: GeneXpertFrTest): string[] {
  const quantified = /^\d/.test(test.result);
  const failed = test.result === 'ERREUR' || test.result === 'PAS DE RÉSULTAT';
  const records = [
    GENEXPERT_FR_HEADER,
    test.patientId ? `P|1|||${test.patientId}|^^^^|||||||||||||||||||||||||||||` : 'P|1||||',
    `O|1|${test.sampleId}||^^^${test.assay}|R|${GENEXPERT_FR_START_TIME}|||||||||ORH||||||||||F`
  ];

  if (test.assay === 'HIV-1') {
    const analyte = failed ? 'PAS DE RÉSULTAT^' : quantified ? 'POS^' : test.result === 'DÉTECTÉ' ? 'POS^' : 'NÉG^';
    const control = failed ? 'PAS DE RÉSULTAT^' : 'RÉUSSITE^';
    records.push(
      frResultRecord(1, '^^^HIV-1^Xpert HIV-1 Viral Load XC^3^^', quantified ? `^${test.result}` : `${test.result}^`, 'copies/mL', '40,00 to 10000000,00', test.flag),
      frResultRecord(2, '^^^HIV-1^Xpert HIV-1 Viral Load XC^3^^LOG', quantified ? '^1,79' : '^', 'copies/mL', '1,60 to 7,00', test.flag)
    );
    if (test.error) {
      records.push(`C|1|I|Error^${test.error.code}^${test.error.title}^${test.error.description}^${GENEXPERT_FR_END_TIME}|N`);
    }
    records.push(
      frDetail(3, '^^^HIV-1^^^HIV-1^', analyte),
      frDetail(4, '^^^HIV-1^^^HIV-1^Ct', failed ? '^0,0' : '^36,9'),
      frDetail(5, '^^^HIV-1^^^HIV-1^EndPt', failed ? '^0,0' : '^264,0'),
      frDetail(6, '^^^HIV-1^^^HIV-1^Delta Ct', quantified ? '^-10,5' : '^'),
      frDetail(7, '^^^HIV-1^^^IQS-H^', control),
      frDetail(8, '^^^HIV-1^^^IQS-H^Ct', failed ? '^0,0' : '^22,4'),
      frDetail(9, '^^^HIV-1^^^IQS-H^EndPt', failed ? '^0,0' : '^757,0'),
      frDetail(10, '^^^HIV-1^^^IQS-L^', control),
      frDetail(11, '^^^HIV-1^^^IQS-L^Ct', failed ? '^0,0' : '^31,2'),
      frDetail(12, '^^^HIV-1^^^IQS-L^EndPt', failed ? '^0,0' : '^176,0')
    );
  } else {
    const qualifier = `^${test.assay}^^HIV-1^`;
    records.push(
      frResultRecord(1, `${qualifier}Xpert HIV-1 Qual XC DBS^1^HIV-1^`, `${test.result}^`, '', '', ''),
      frDetail(2, `${qualifier}^^SPC^`, 'RÉUSSITE^'),
      frDetail(3, `${qualifier}^^SPC^Ct`, '^32,7'),
      frDetail(4, `${qualifier}^^SPC^EndPt`, '^162,0'),
      frDetail(5, `${qualifier}^^SAC^`, 'RÉUSSITE^'),
      frDetail(6, `${qualifier}^^SAC^Ct`, '^23,4'),
      frDetail(7, `${qualifier}^^SAC^EndPt`, '^203,0'),
      frDetail(8, `${qualifier}^^HIV-1^`, test.result === 'DÉTECTÉ' ? 'POS^' : 'NÉG^'),
      frDetail(9, `${qualifier}^^HIV-1^Ct`, '^0,0'),
      frDetail(10, `${qualifier}^^HIV-1^EndPt`, '^1,0'),
      frResultRecord(11, `^${test.assay}^^QC-1^Xpert HIV-1 Qual XC DBS^1^QC^`, '^', '', '', ''),
      frDetail(12, `^${test.assay}^^QC-1^^^QC-1^`, 'NÉG^'),
      frDetail(13, `^${test.assay}^^QC-1^^^QC-1^Ct`, '^0,0'),
      frDetail(14, `^${test.assay}^^QC-1^^^QC-1^EndPt`, '^0,0'),
      frDetail(15, `^${test.assay}^^QC-1^^^QC-2^`, 'NÉG^'),
      frDetail(16, `^${test.assay}^^QC-1^^^QC-2^Ct`, '^0,0'),
      frDetail(17, `^${test.assay}^^QC-1^^^QC-2^EndPt`, '^0,0')
    );
  }

  records.push('L|1|N');
  return records;
}

export function genexpertFrSession(test: GeneXpertFrTest): string {
  return ENQ + genexpertFrames(genexpertFrMessage(test)).join('') + EOT;
}

export const GENEXPERT_FR_TESTS: GeneXpertFrTest[] = [
  { sampleId: 'Xpert H 040726163316', patientId: '00200 CV', assay: 'HIV-1', result: '60,96', flag: 'N' },
  { sampleId: 'VL07260009', patientId: 'CV HKP00138', assay: 'HIV-1', result: 'NON DÉTECTÉ', flag: 'A' },
  { sampleId: 'VL04260007', patientId: 'HKP00389', assay: 'HIV-1', result: 'DÉTECTÉ', flag: '<' },
  { sampleId: 'VL04260004', assay: 'HIV-1', result: '1420403,41', flag: 'N' },
  { sampleId: 'VL05260008', assay: 'HIV-1', result: 'PAS DE RÉSULTAT', flag: 'A' },
  {
    sampleId: 'VL08260017', assay: 'HIV-1', result: 'ERREUR', flag: 'A',
    error: { code: '2096', title: 'Opération arrêtée', description: 'Erreur 2096: Erreur d\'expiration spécifique au test n°1 : 18, 30, 0, 0' }
  },
  { sampleId: 'Xpert H 040726162551', patientId: '076  EID', assay: 'HIV_QUALXC1', result: 'NON DÉTECTÉ', flag: '' },
  { sampleId: 'EID08260001', assay: 'HIV_QUALXC1', result: 'DÉTECTÉ', flag: '' }
];
