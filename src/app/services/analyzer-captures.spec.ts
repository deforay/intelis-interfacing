/**
 * Replays transmissions shaped exactly like production captures from the
 * analyzers this tool is deployed against. See the fixture files for what
 * each capture showed. These tests are the contract with the field: a
 * change that alters what a real analyzer's message stores must fail here.
 */
import { describe, expect, it, vi } from 'vitest';
import { ACK, EOT, ENQ, NAK, createWireHarness, mllp } from '../testing/wire-harness';
import {
  M2000_RESULT_TIME_FORMATTED, M2000_RUN_SAMPLES, m2000Frames, m2000Message, m2000Session
} from '../testing/fixtures/captured/abbott-m2000';
import {
  ALINITY_BATCH, ALINITY_BELOW_RANGE, ALINITY_NOT_DETECTED, ALINITY_QUANTIFIED,
  ALINITY_RESULT_TIME_FORMATTED, alinityMessage
} from '../testing/fixtures/captured/abbott-alinity-m';
import {
  COBAS_5800_CAPTURE, COBAS_5800_CLOT_ERROR, COBAS_5800_PIPETTING_ERROR, COBAS_5800_RESULT_TIME_FORMATTED
} from '../testing/fixtures/captured/roche-cobas-5800';
import {
  COBAS_6800_CAPTURE, COBAS_6800_RESULT_TIME_FORMATTED, cobas6800Query
} from '../testing/fixtures/captured/roche-cobas-6800';
import {
  COBAS_4800_RESULT_TIME_FORMATTED, COBAS_4800_RUN, COBAS_4800_THIRD_LAB_RUN, cobas4800Query, cobas4800Run
} from '../testing/fixtures/captured/roche-cobas-4800';
import {
  TAQMAN_COMPLETED_TIME_FORMATTED, TAQMAN_LAB, TAQMAN_SAMPLES, taqmanFrames, taqmanMessage, taqmanSession
} from '../testing/fixtures/captured/roche-cobas-taqman';
import {
  GENEXPERT_END_TIME_FORMATTED, GENEXPERT_FR_END_TIME_FORMATTED, GENEXPERT_FR_OPERATOR, GENEXPERT_FR_TESTS,
  GENEXPERT_TESTS, genexpertFrMessage, genexpertFrames, genexpertMessage, genexpertSession
} from '../testing/fixtures/captured/cepheid-genexpert';

describe('Abbott m2000 capture (ASTM)', () => {
  const expectRun = (results: any[]) => {
    expect(results.map(result => result.order_id)).toEqual(M2000_RUN_SAMPLES.map(sample => sample.specimenId));
    expect(results.map(result => result.test_id)).toEqual(M2000_RUN_SAMPLES.map(sample => sample.specimenId));
    expect(results.map(result => result.results)).toEqual([
      'Not detected', '1523', '1094012', 'Not detected', '< 40', '86321', 'Failed', 'Not detected'
    ]);
    expect(results.map(result => result.result_status)).toEqual([1, 1, 1, 1, 1, 1, 0, 1]);
    expect(results[5]).toMatchObject({
      test_type: 'HIV0.6ml',
      test_unit: 'Copies / mL',
      tested_by: 'admin^Administrator',
      analysed_date_time: M2000_RESULT_TIME_FORMATTED,
      notes: ''
    });
    expect(results[6]).toMatchObject({
      test_unit: null,
      tested_by: null,
      analysed_date_time: null,
      notes: '4442 : Internal control cycle number is too high. Valid range is [19.19, 23.19].'
    });
    for (const result of results) {
      expect(result.results, result.order_id).not.toMatch(/^[0-9A-F]{2}$/);
    }
  };

  it('stores every sample of a run sent as one session with checksums verified', () => {
    const wire = createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });
    const frames = m2000Frames(M2000_RUN_SAMPLES.map(m2000Message));

    wire.receive(ENQ + frames.join('') + EOT);

    expect(wire.sent()).toEqual(Array(frames.length + 2).fill(ACK));
    expect(wire.sent()).not.toContain(NAK);
    expectRun(wire.saved());
    expect(wire.raw()).toHaveLength(1);
  });

  it('stores the same run when the laboratory configures the analyzer without checksums', () => {
    const wire = createWireHarness({ protocol: 'astm-nonchecksum', machineType: 'abbott-m2000' });
    const frames = m2000Frames(M2000_RUN_SAMPLES.map(m2000Message));

    wire.receive(ENQ);
    for (const frame of frames) {
      wire.receive(frame);
    }
    wire.receive(EOT);

    expect(wire.sent()).toEqual(Array(frames.length + 2).fill(ACK));
    expectRun(wire.saved());
  });

  it('stores the run when a session without checksums arrives in a single read', () => {
    const wire = createWireHarness({ protocol: 'astm-nonchecksum', machineType: 'abbott-m2000' });

    wire.receive(m2000Session(M2000_RUN_SAMPLES));

    expectRun(wire.saved());
    expect(wire.raw()).toHaveLength(1);
  });

  it('handles the session arriving in segment-sized chunks', () => {
    const wire = createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });

    wire.receiveInChunks(m2000Session(M2000_RUN_SAMPLES), 1400);

    expect(wire.sent()).not.toContain(NAK);
    expectRun(wire.saved());
  });

  for (const protocol of ['astm-checksum', 'astm-nonchecksum'] as const) {
    it(`ignores the empty sessions and stray NUL byte the analyzer sends between runs (${protocol})`, () => {
      const wire = createWireHarness({ protocol, machineType: 'abbott-m2000' });

      wire.receive(EOT + ENQ + EOT + ENQ + EOT);
      wire.receive(ENQ);
      wire.receive(EOT);
      wire.receive('\x00' + m2000Session(M2000_RUN_SAMPLES));

      expect(wire.failures()).toEqual([]);
      expect(wire.raw()).toHaveLength(1);
      expectRun(wire.saved());
    });
  }

  it('stores a result whose order record ends before its test identifier', () => {
    // An order record may stop after the specimen IDs. Reading the missing
    // test identifier used to throw, and the sample's result was dropped
    // without a failure being recorded.
    const shortOrder = M2000_RUN_SAMPLES[1];
    const messages = [m2000Message(M2000_RUN_SAMPLES[0]), m2000Message(shortOrder)];
    messages[1] = messages[1].map(record => record.startsWith('O|') ? `O|1|${shortOrder.specimenId}|${shortOrder.specimenId}` : record);
    const wire = createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });

    wire.receive(ENQ + m2000Frames(messages).join('') + EOT);

    expect(wire.saved().map(result => [result.order_id, result.results])).toEqual([
      [M2000_RUN_SAMPLES[0].specimenId, M2000_RUN_SAMPLES[0].result],
      [shortOrder.specimenId, shortOrder.result]
    ]);
    expect(wire.failures()).toEqual([]);
  });

  it('records a failure for an order whose result cannot be read, and still stores the rest', () => {
    const wire = createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });
    const extract = wire.astmHelper.extractSampleResultFromASTM.bind(wire.astmHelper);
    vi.spyOn(wire.astmHelper, 'extractSampleResultFromASTM').mockImplementation((dataArray: any, partData: string) =>
      dataArray['O']?.[0]?.[2] === M2000_RUN_SAMPLES[1].specimenId ? null : extract(dataArray, partData)
    );

    wire.receive(m2000Session(M2000_RUN_SAMPLES.slice(0, 3)));

    expect(wire.saved().map(result => result.order_id)).toEqual([M2000_RUN_SAMPLES[0].specimenId, M2000_RUN_SAMPLES[2].specimenId]);
    expect(wire.failures()).toEqual(['result_parsing_failed']);
    expect(wire.raw()).toHaveLength(1);
  });

  it('keeps frame numbers continuous across the messages of a session', () => {
    const frames = m2000Frames(M2000_RUN_SAMPLES.map(m2000Message));
    const numbers = frames.map(frame => frame.charAt(1));

    expect(numbers.slice(0, 9)).toEqual(['1', '2', '3', '4', '5', '6', '7', '0', '1']);
    expect(numbers).toHaveLength(M2000_RUN_SAMPLES.reduce((count, sample) => count + m2000Message(sample).length, 0));
  });
});

describe('Abbott Alinity m capture (HL7)', () => {
  for (const machineType of ['abbott-alinity-m', 'generic']) {
    describe(`configured as ${machineType}`, () => {
      it('stores a not-detected result with the sample ID taken from SAC.3', () => {
        const wire = createWireHarness({ protocol: 'hl7', machineType });

        wire.receive(mllp(alinityMessage(ALINITY_NOT_DETECTED)));

        expect(wire.saved()).toHaveLength(1);
        expect(wire.saved()[0]).toMatchObject({
          order_id: 'VL00000101',
          test_id: 'VL00000101',
          test_type: 'HIV-1',
          results: 'Not Detected',
          test_unit: '',
          notes: '',
          tested_by: 'Pat~operator',
          analysed_date_time: ALINITY_RESULT_TIME_FORMATTED,
          result_status: 1
        });
        expect(wire.sent()).toHaveLength(1);
      });

      it('stores a below-range result with the unit read from the second OBX.6 component', () => {
        const wire = createWireHarness({ protocol: 'hl7', machineType });

        wire.receive(mllp(alinityMessage(ALINITY_BELOW_RANGE)));

        expect(wire.saved()[0]).toMatchObject({ order_id: 'VL00000102', results: '< 20', test_unit: 'Copies/mL' });
      });

      it('stores a quantified result as printed, thousands separator included, with its unit', () => {
        const wire = createWireHarness({ protocol: 'hl7', machineType });

        wire.receive(mllp(alinityMessage(ALINITY_QUANTIFIED)));

        expect(wire.saved()[0]).toMatchObject({ order_id: 'VL00000103', results: '161,152', test_unit: 'Copies/mL' });
      });

      it('stores every sample when newer software sends five blocks in one chunk', () => {
        const wire = createWireHarness({ protocol: 'hl7', machineType });

        wire.receive(ALINITY_BATCH.map(sample => mllp(alinityMessage(sample))).join(''));

        expect(wire.saved().map(result => [result.order_id, result.results, result.test_unit])).toEqual([
          ['VL00000102', '< 20', 'Copies/mL'],
          ['VL00000103', '161,152', 'Copies/mL'],
          ['VL00000104', '32', 'Copies/mL'],
          ['VL00000105', 'Not Detected', ''],
          ['VL00000106', '3,512', 'Copies/mL']
        ]);
        expect(wire.sent()).toHaveLength(5);
        expect(wire.raw()).toHaveLength(5);
      });
    });
  }
});

describe('Roche cobas 5800 capture (HL7)', () => {
  for (const machineType of ['roche-cobas-5800', 'generic']) {
    it(`stores all eight messages of the capture configured as ${machineType}`, () => {
      const wire = createWireHarness({ protocol: 'hl7', machineType });

      for (const message of COBAS_5800_CAPTURE) {
        wire.receive(mllp(message));
      }

      expect(wire.sent()).toHaveLength(8);
      // Mantissa and UCUM exponent unit are stored exactly as sent
      expect(wire.saved().map(result => [result.order_id, result.results, result.test_unit, result.notes])).toEqual([
        ['VL00000407', 'Failed', '', COBAS_5800_PIPETTING_ERROR],
        ['VL00000397', 'Failed', '', COBAS_5800_CLOT_ERROR],
        ['VL00000671', 'Failed', '', COBAS_5800_CLOT_ERROR],
        ['VL00000427', '367', '10*-1.{copies}/mL', ''],
        ['VL00000428', '101', '10*0.{copies}/mL', ''],
        ['VL00000429', '337', '10*-1.{copies}/mL', ''],
        ['VL00000430', 'Target Not Detected', '', ''],
        ['VL00000431', 'Target Not Detected', '', '']
      ]);
      expect(wire.saved()[3]).toMatchObject({
        test_id: 'VL00000427',
        test_type: 'HIV',
        tested_by: 'labolnrs',
        analysed_date_time: COBAS_5800_RESULT_TIME_FORMATTED
      });
      expect(wire.saved()[0].tested_by).toBe('');
    });
  }
});

describe('Roche cobas 6800/8800 capture (HL7)', () => {
  it('stores the mantissa and UCUM exponent unit as sent and maps every outcome', () => {
    const wire = createWireHarness({ protocol: 'hl7', machineType: 'roche-cobas-6800' });

    wire.receive(COBAS_6800_CAPTURE.map(message => mllp(message)).join(''));

    expect(wire.sent()).toHaveLength(6);
    expect(wire.saved().map(result => [result.order_id, result.results, result.test_unit])).toEqual([
      ['WB26-02146', '763', '10*-1.{Copies}/mL'],
      ['BP26-15201', '194', '10*0.{Copies}/mL'],
      ['BP26-15202', '226', '10*4.{Copies}/mL'],
      ['WB26-02135', 'Target Not Detected', ''],
      ['BP26-15178', '< Titer min', ''],
      ['BP26-16850', 'Invalid', '']
    ]);
    expect(wire.saved()[0]).toMatchObject({
      test_id: 'WB26-02146',
      test_type: 'HIV',
      tested_by: 'Lyneldra',
      analysed_date_time: COBAS_6800_RESULT_TIME_FORMATTED,
      result_status: 1
    });
  });

  it('acknowledges a work-order query without storing anything', () => {
    const wire = createWireHarness({ protocol: 'hl7', machineType: 'roche-cobas-6800' });

    wire.receive(mllp(cobas6800Query('MSG-6800-Q1', 'BP26-18068')));

    expect(wire.sent()).toHaveLength(1);
    expect(wire.saved()).toHaveLength(0);
    expect(wire.failures()).toHaveLength(0);
  });
});

describe('Roche cobas 4800 capture (HL7)', () => {
  for (const machineType of ['roche-cobas-4800', 'generic']) {
    it(`stores every sample of a run message configured as ${machineType}`, () => {
      const wire = createWireHarness({ protocol: 'hl7', machineType });

      wire.receive(mllp(cobas4800Run('MSG-4800-RUN', COBAS_4800_RUN)));

      expect(wire.sent()).toHaveLength(1);
      // Scientific notation and the 1/mL unit are stored exactly as sent
      expect(wire.saved().map(result => [result.order_id, result.results, result.test_unit])).toEqual([
        ['0PHJ100001N0QVJ', '3.26E+05 cp/mL', '1/mL'],
        ['0PLJ100002N07UX', '2.46E+02 cp/mL', '1/mL'],
        ['0N1J100003O0OEZ', 'Target Not Detected', ''],
        ['VL260001', 'Target Not Detected', ''],
        ['VL260002', '< Titer min', ''],
        ['VL260003', '6.73E+01 cp/mL', '1/mL'],
        ['VL260004', 'Invalid', ''],
        ['VL260005', '1.70E+05 cp/mL', '1/mL']
      ]);
      expect(wire.saved()[0]).toMatchObject({
        test_id: '0PHJ100001N0QVJ',
        test_type: '0BHIV1',
        tested_by: 'Laboperator01',
        analysed_date_time: COBAS_4800_RESULT_TIME_FORMATTED
      });
      expect(wire.saved().map(result => result.results)).not.toContain('20260612163740^20260612194324');
    });
  }

  it('stores the outcomes a third laboratory sends, as they are stored today', () => {
    const wire = createWireHarness({ protocol: 'hl7', machineType: 'roche-cobas-4800' });

    wire.receive(mllp(cobas4800Run('MSG-4800-LAB3', COBAS_4800_THIRD_LAB_RUN)));

    expect(wire.saved().map(result => [result.order_id, result.test_type, result.results, result.test_unit, result.result_status, result.notes])).toEqual([
      // P is stored as final: this laboratory never sends most results as F.
      ['VL230101', '0BHIV1', '4.12E+03 cp/mL', '1/mL', 1, ''],
      ['VL230102', '0BHIV1', 'Target Not Detected', '', 1, ''],
      // Open: the NTE flag codes that explain a failure are not kept in notes.
      ['VL230103', '0BHIV1', 'Failed', '', 1, ''],
      ['VL230104', '0BHIV1', 'Failed', '', 1, ''],
      ['VL230105', '0BHIV1', 'Invalid', '', 1, ''],
      // Open: rewritten from "> Titer max", a value the analyzer did not send.
      ['VL230106', '0BHIV1', '> 10000000', '', 1, ''],
      ['EID230107', '0BHIV1QUAL', 'Not Detected', '', 1, ''],
      ['EID230108', '0BHIV1QUAL', 'Detected', '', 1, ''],
      ['0PLJ230109N0AUQ', '0BHIV1QUAL', 'Valid', '', 1, ''],
      // A control that failed before it was identified keeps no sample ID.
      ['', '0BHIV1', 'Failed', '', 1, '']
    ]);
    expect(wire.failures()).toEqual([]);
  });

  it('acknowledges a work-order query without storing anything', () => {
    const wire = createWireHarness({ protocol: 'hl7', machineType: 'roche-cobas-4800' });

    wire.receive(mllp(cobas4800Query('MSG-4800-Q1', 'VL260006')));

    expect(wire.sent()).toHaveLength(1);
    expect(wire.saved()).toHaveLength(0);
  });
});

describe('Cepheid GeneXpert capture (ASTM)', () => {
  const expected = [
    ['EID26000576U', 'HIV-1_QUAL 2', 'DETECTED', '', ''],
    ['EID26000580O', 'HIV-1_QUAL 2', 'NOT DETECTED', '', ''],
    ['VALERIAH M', 'HIV-1_QUAL 2', 'ERROR', '', 'Error 2097: Assay-Specific Termination Error #2: 46, 7, 1, 0 | Error 2097: Assay-Specific Termination Error #2: 46, 7, 1, 0'],
    ['bp26-00064', 'HIV-1_VL 2 2', 'NOT DETECTED', 'copies/mL', ''],
    ['bp26-00065', 'HIV-1_VL 2 2', '1234.56', 'copies/mL', ''],
    ['sp26-00147', 'MTB-RIF_ULTRA 2', 'NOT DETECTED', '', '']
  ];

  it('cuts records across 240-byte ETB frames exactly as the analyzer does', () => {
    const frames = genexpertFrames(genexpertMessage(GENEXPERT_TESTS[0]));

    expect(frames.length).toBeGreaterThan(3);
    expect(frames.slice(0, -1).every(frame => frame.includes('\x17'))).toBe(true);
    expect(frames[frames.length - 1]).toContain('\x03');
    // STX, frame number, 240-byte body, ETB, two checksum characters, CR LF
    expect(Math.max(...frames.map(frame => frame.length))).toBe(247);
  });

  for (const protocol of ['astm-checksum', 'astm-nonchecksum'] as const) {
    it(`stores every test faithfully across ETB continuation frames (${protocol})`, () => {
      const wire = createWireHarness({ protocol, machineType: 'cepheid-genexpert' });

      for (const test of GENEXPERT_TESTS) {
        if (protocol === 'astm-checksum') {
          wire.receive(genexpertSession(test));
        } else {
          wire.receive(ENQ);
          for (const frame of genexpertFrames(genexpertMessage(test))) {
            wire.receive(frame);
          }
          wire.receive(EOT);
        }
      }

      expect(wire.sent()).not.toContain(NAK);
      expect(wire.saved().map(result => [result.order_id, result.test_type, result.results, result.test_unit, result.notes])).toEqual(expected);
      expect(wire.saved()[0]).toMatchObject({
        test_id: 'EID26000576U',
        tested_by: 'ALBERT MUDUNGWE',
        analysed_date_time: GENEXPERT_END_TIME_FORMATTED,
        result_status: 1
      });
      for (const result of wire.saved()) {
        expect(result.raw_text, result.order_id).not.toMatch(/\x17|\x02/);
      }
    });
  }
});


/**
 * A laboratory reported empty and truncated results while running an
 * older build: records cut across ETB frames were not rejoined, so a result
 * either lost every field after the cut or kept the frame's ETB and checksum
 * inside the value ("co\x17E4" instead of "copies/mL"). These replay the
 * capture that showed it.
 */
describe('Cepheid GeneXpert 6.5 French capture (ASTM)', () => {
  const expected = [
    ['Xpert H 040726163316', 'HIV-1', '60,96', 'copies/mL', ''],
    ['VL07260009', 'HIV-1', 'NON DÉTECTÉ', 'copies/mL', ''],
    ['VL04260007', 'HIV-1', 'DÉTECTÉ', 'copies/mL', ''],
    ['VL04260004', 'HIV-1', '1420403,41', 'copies/mL', ''],
    ['VL05260008', 'HIV-1', 'PAS DE RÉSULTAT', 'copies/mL', ''],
    ['VL08260017', 'HIV-1', 'ERREUR', 'copies/mL', 'Erreur 2096: Erreur d\'expiration spécifique au test n°1\u00a0: 18, 30, 0, 0'],
    ['Xpert H 040726162551', 'HIV_QUALXC1', 'NON DÉTECTÉ', '', ''],
    ['EID08260001', 'HIV_QUALXC1', 'DÉTECTÉ', '', '']
  ];

  for (const protocol of ['astm-checksum', 'astm-nonchecksum'] as const) {
    it(`rejoins records cut mid-field across frames, in French and with decimal commas (${protocol})`, () => {
      const wire = createWireHarness({ protocol, machineType: 'cepheid-genexpert' });

      for (const test of GENEXPERT_FR_TESTS) {
        const frames = genexpertFrames(genexpertFrMessage(test));
        if (protocol === 'astm-checksum') {
          wire.receive(ENQ + frames.join('') + EOT);
        } else {
          wire.receive(ENQ);
          for (const frame of frames) {
            wire.receive(frame);
          }
          wire.receive(EOT);
        }
      }

      expect(wire.sent()).not.toContain(NAK);
      expect(wire.saved().map(result => [result.order_id, result.test_type, result.results, result.test_unit, result.notes])).toEqual(expected);
      expect(wire.saved()[0]).toMatchObject({
        test_id: 'Xpert H 040726163316',
        tested_by: GENEXPERT_FR_OPERATOR,
        analysed_date_time: GENEXPERT_FR_END_TIME_FORMATTED,
        result_status: 1
      });
      for (const result of wire.saved()) {
        expect(result.results, result.order_id).not.toMatch(/[\x02\x03\x17]/);
        expect(result.test_unit, result.order_id).not.toMatch(/[\x02\x03\x17]/);
        expect(result.raw_text, result.order_id).not.toMatch(/\x17|\x02/);
      }
    });
  }

  it('recovers every result when the whole session arrives as one chunk', () => {
    const wire = createWireHarness({ protocol: 'astm-nonchecksum', machineType: 'cepheid-genexpert' });

    for (const test of GENEXPERT_FR_TESTS) {
      wire.receive(ENQ + genexpertFrames(genexpertFrMessage(test)).join(''));
      wire.receive(EOT);
    }

    expect(wire.saved().map(result => [result.order_id, result.test_type, result.results, result.test_unit, result.notes])).toEqual(expected);
  });
});

describe('Roche COBAS TaqMan 96 capture (ASTM)', () => {
  const expectResults = (results: any[]) => {
    expect(results.map(result => [result.order_id, result.results, result.test_unit, result.notes])).toEqual([
      ['TM-0001/26', 'Target Not Detected', '', 'Accepted | STEP_CORR-2 | RFITOOLOW-1'],
      ['TM-0002/26', '2.52E+3 (3.40)', 'cp/mL', 'Accepted | STEP_CORR-2 | SPK_CORR-2'],
      ['QC 1', '1035.95864507225', 'cp/ml', 'Accepted | STEP_CORR-2'],
      ['QC 2', '58.9827777398403', 'cp/ml', 'Accepted | STEP_CORR-2'],
      ['QC  20', 'Target Not Detected', '', 'Accepted | STEP_CORR-2 | RFITOOLOW-1']
    ]);
    for (const result of results) {
      expect(result, result.order_id).toMatchObject({
        test_id: result.order_id,
        tested_by: TAQMAN_LAB,
        analysed_date_time: TAQMAN_COMPLETED_TIME_FORMATTED,
        // Undecided, pinned as stored today: see the fixture. A change to
        // either must be a decision, not a side effect.
        test_type: 'ALL',
        result_status: 0
      });
      expect(result.results, result.order_id).not.toMatch(/[\x00-\x1f]/);
      expect(result.raw_text, result.order_id).not.toMatch(/[\x02\x03]/);
    }
  };

  // The logs do not show TaqMan's framing, so both are replayed, each in the
  // protocol a laboratory would configure for it.
  const configurations = [
    { framing: 'checksum', protocol: 'astm-checksum' },
    { framing: 'no-checksum', protocol: 'astm-nonchecksum' }
  ] as const;

  for (const { framing, protocol } of configurations) {
    it(`stores a batch delivered as one session in a single read (${protocol})`, () => {
      const wire = createWireHarness({ protocol, machineType: 'roche-cobas-taqman' });

      wire.receive(taqmanSession(TAQMAN_SAMPLES, framing));

      expectResults(wire.saved());
      expect(wire.raw()).toHaveLength(1);
      expect(wire.failures()).toEqual([]);
      expect(wire.sent()).not.toContain(NAK);
    });

    it(`stores the same batch when every frame arrives in its own read (${protocol})`, () => {
      const wire = createWireHarness({ protocol, machineType: 'roche-cobas-taqman' });

      wire.receive(ENQ);
      for (const frame of taqmanFrames(TAQMAN_SAMPLES.map(taqmanMessage), framing)) {
        wire.receive(frame);
      }
      wire.receive(EOT);

      expectResults(wire.saved());

      // How the bytes were split must not change what is stored: each result
      // keeps its own message as raw text, never the rest of the batch.
      const whole = createWireHarness({ protocol, machineType: 'roche-cobas-taqman' });
      whole.receive(taqmanSession(TAQMAN_SAMPLES, framing));
      expect(whole.saved().map(result => result.raw_text)).toEqual(wire.saved().map(result => result.raw_text));
      for (const result of wire.saved()) {
        expect(result.raw_text.match(/\|\^\^\^ALL\|/g), result.order_id).toHaveLength(1);
      }
    });
  }
});
