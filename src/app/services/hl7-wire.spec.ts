import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstrumentInterfaceService } from './instrument-interface.service';
import { ACK, CR, FS, LF, VT, createWireHarness, mllp, parseHL7Response } from '../testing/wire-harness';
import {
  ALINITY_M_QUANTIFIED, GENERIC_BATCH, GENERIC_ENCODED_VALUE, GENERIC_ERROR, GENERIC_HIV_VL,
  GENERIC_INCOMPLETE, GENERIC_TESTER_ON_OBR, MISSING_OBX, MISSING_SPM, ROCHE_5800_NOT_DETECTED_FLAG,
  ROCHE_5800_QUANTIFIED, ROCHE_6800_ABOVE_RANGE, ROCHE_6800_BELOW_RANGE, ROCHE_6800_INSTRUMENT_ERROR,
  ROCHE_6800_QUANTIFIED, ROCHE_6800_TARGET_NOT_DETECTED_FLAG, ROCHE_6800_TITER, RUN_DATE_FORMATTED, msh, obx as obxSegment
} from '../testing/fixtures/hl7.fixtures';

describe('HL7 over the wire', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const harness = (machineType = 'generic') => createWireHarness({ protocol: 'hl7', machineType });

  describe('accepts conforming messages', () => {
    it('stores a generic viral load result with every field mapped', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_HIV_VL));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({
        order_id: 'SAMPLE-GX-001',
        test_id: 'SAMPLE-GX-001',
        test_type: 'HIV-1 Viral Load',
        results: '1250',
        test_unit: 'copies/mL',
        notes: '',
        tested_by: 'TECH-1',
        analysed_date_time: RUN_DATE_FORMATTED,
        authorised_date_time: RUN_DATE_FORMATTED,
        result_accepted_date_time: RUN_DATE_FORMATTED,
        result_status: 1,
        lims_sync_status: 0,
        test_location: 'LAB001',
        machine_used: 'ANALYZER-1',
        instrument_id: 'ANALYZER-1'
      });
      expect(wire.saved()[0].raw_text).toContain('MSG-GX-001');
    });

    it('answers with an application-accept ACK that echoes the message ID, version and character set', () => {
      const wire = harness();

      wire.receive(mllp(msh('GeneXpert', 'MSG-ACK-1', { version: '2.3.1', characterSet: '8859/1' }) + CR + 'SPM|1|S' + CR + 'OBX|1|ST|T|1|5|u|||||F'));

      expect(wire.sent()).toHaveLength(1);
      const response = wire.sent()[0];
      expect(response.startsWith(VT)).toBe(true);
      expect(response.endsWith(FS + CR)).toBe(true);
      const segments = parseHL7Response(response);
      // Field n of MSH sits at index n-1 because MSH-1 is the separator itself
      expect(segments.MSH[8]).toBe('ACK^R22^ACK');
      expect(segments.MSH[11]).toBe('2.3.1');
      expect(segments.MSH[17]).toBe('8859/1');
      expect(segments.MSA).toEqual(['MSA', 'AA', 'MSG-ACK-1']);
    });

    it('stores the block verbatim as raw data', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_HIV_VL));

      expect(wire.raw()).toEqual([mllp(GENERIC_HIV_VL)]);
    });

    it('stores one result per specimen in a batch message', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_BATCH));

      expect(wire.saved().map(result => [result.order_id, result.results])).toEqual([
        ['SAMPLE-B-001', '820'],
        ['SAMPLE-B-002', 'Target Not Detected'],
        ['SAMPLE-B-003', '15400']
      ]);
      expect(wire.sent()).toHaveLength(1);
    });

    it('processes two blocks that arrive in one chunk and ACKs each', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_HIV_VL) + mllp(GENERIC_BATCH));

      expect(wire.saved()).toHaveLength(4);
      expect(wire.sent()).toHaveLength(2);
      expect(parseHL7Response(wire.sent()[0]).MSA[2]).toBe('MSG-GX-001');
      expect(parseHL7Response(wire.sent()[1]).MSA[2]).toBe('MSG-GX-BATCH');
    });

    it('handles a block delivered one byte at a time', () => {
      const wire = harness();

      wire.receiveInChunks(mllp(GENERIC_HIV_VL), 1);

      expect(wire.saved()).toHaveLength(1);
      expect(wire.sent()).toHaveLength(1);
    });

    it('handles a trailing CR that arrives after the block separator', () => {
      const wire = harness();

      wire.receive(VT + GENERIC_HIV_VL + FS);
      wire.receive(CR);
      wire.receive(mllp(GENERIC_BATCH));

      expect(wire.saved()).toHaveLength(4);
      expect((wire.service as any).hl7ReceiveBuffers.has('ANALYZER-1')).toBe(false);
      // The block waited for its terminator, so what is stored is the block
      // the analyzer sent and not one byte less.
      expect(wire.raw()[0]).toBe(mllp(GENERIC_HIV_VL));
    });

    it('stores a block whose analyzer never sends the trailing CR', () => {
      vi.useFakeTimers();
      const wire = harness();

      wire.receive(VT + GENERIC_HIV_VL + FS);
      expect(wire.saved()).toHaveLength(0);

      // Waiting for a byte the analyzer does not send must not cost a result.
      vi.advanceTimersByTime(InstrumentInterfaceService.MLLP_TERMINATOR_GRACE_MS);

      expect(wire.saved()).toHaveLength(1);
      expect(wire.raw()[0]).toBe(mllp(GENERIC_HIV_VL, { cr: false }));
    });

    it('stores a block waiting for its CR when the connection goes away first', () => {
      vi.useFakeTimers();
      const wire = harness();

      wire.receive(VT + GENERIC_HIV_VL + FS);
      wire.disconnect();

      // The analyzer finished sending this result. Disconnecting inside the
      // grace period must not be what loses it.
      expect(wire.saved()).toHaveLength(1);
      expect(wire.raw()).toEqual([mllp(GENERIC_HIV_VL, { cr: false })]);
    });

    it('leaves the next block alone when the CR arrives after the grace has passed', () => {
      vi.useFakeTimers();
      const wire = harness();

      wire.receive(VT + GENERIC_HIV_VL + FS);
      vi.advanceTimersByTime(InstrumentInterfaceService.MLLP_TERMINATOR_GRACE_MS);
      // Past the grace the block has been taken, so this <CR> belongs to a
      // block already stored: it is noise on the wire now, and must not become
      // part of the next one.
      wire.receive(CR);
      wire.receive(mllp(GENERIC_BATCH));

      expect(wire.saved()).toHaveLength(4);
      expect(wire.raw()).toEqual([mllp(GENERIC_HIV_VL, { cr: false }), mllp(GENERIC_BATCH)]);
    });

    it('stores the unit as the analyzer wrote it, padding included', () => {
      const wire = harness();
      const padded = GENERIC_HIV_VL.replace('|copies/mL|', '| copies/mL |');

      wire.receive(mllp(padded));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0].test_unit).toBe(' copies/mL ');
    });

    it('accepts a block without a start byte and CR LF segment endings', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_HIV_VL.split(CR).join(CR + LF), { vt: false }));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0].results).toBe('1250');
    });

    it('stores an Abbott Alinity m result using the specimen ID from SPM.3', () => {
      const wire = harness('abbott-alinity-m');

      wire.receive(mllp(ALINITY_M_QUANTIFIED));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({
        order_id: 'SAMPLE-ALM-001',
        test_id: 'SAMPLE-ALM-001',
        test_type: 'HIV-1 Viral Load',
        results: '5600',
        test_unit: 'copies/mL',
        tested_by: 'TECH-4',
        analysed_date_time: RUN_DATE_FORMATTED
      });
    });

    it('stores a Roche cobas 6800/8800 result from the 1/2 observation with the &ROCHE suffix removed', () => {
      const wire = harness('roche-cobas-6800');

      wire.receive(mllp(ROCHE_6800_QUANTIFIED));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({
        order_id: 'SAMPLE-6800-001',
        test_id: 'SAMPLE-6800-001',
        test_type: 'HIV-1 RNA',
        results: '1250',
        test_unit: 'copies/mL',
        tested_by: 'TECH-1',
        analysed_date_time: RUN_DATE_FORMATTED
      });
    });

    it('maps Roche cobas 6800/8800 range and flag outcomes', () => {
      const cases: Array<[string, string, string]> = [
        [ROCHE_6800_BELOW_RANGE, '< 20', 'copies/mL'],
        [ROCHE_6800_ABOVE_RANGE, '> 10000000', ''],
        [ROCHE_6800_TARGET_NOT_DETECTED_FLAG, 'Target Not Detected', '']
      ];
      for (const [fixture, results, unit] of cases) {
        const wire = harness('roche-cobas-6800');
        wire.receive(mllp(fixture));
        expect(wire.saved(), fixture).toHaveLength(1);
        expect(wire.saved()[0], fixture).toMatchObject({ results, test_unit: unit });
      }
    });

    it('stores a Roche cobas 6800/8800 Titer outcome from the first observation', () => {
      const wire = harness('roche-cobas-6800');

      wire.receive(mllp(ROCHE_6800_TITER));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({ order_id: 'SAMPLE-6800-006', results: 'Titer', test_unit: 'copies/mL' });
    });

    it('stores a Roche cobas 5800 result and its not-detected flag', () => {
      const quantified = harness('roche-cobas-5800');
      quantified.receive(mllp(ROCHE_5800_QUANTIFIED));
      expect(quantified.saved()[0]).toMatchObject({ order_id: 'SAMPLE-5800-001', results: '3400', test_unit: 'copies/mL', tested_by: 'TECH-3' });

      const flagged = harness('roche-cobas-5800');
      flagged.receive(mllp(ROCHE_5800_NOT_DETECTED_FLAG));
      expect(flagged.saved()[0]).toMatchObject({ order_id: 'SAMPLE-5800-002', results: 'Target Not Detected', test_unit: '' });
    });

    it('decodes HTML entities in result values', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_ENCODED_VALUE));

      expect(wire.saved()[0].results).toBe('<40');
    });

    it('falls back to the operator on OBR.34 when OBX.16 is empty', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_TESTER_ON_OBR));

      expect(wire.saved()[0].tested_by).toBe('TECH-OBR');
    });

    it('keeps sessions from the same instrument separate', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_HIV_VL));
      wire.receive(mllp(GENERIC_ENCODED_VALUE));

      expect(wire.raw()).toHaveLength(2);
      expect(wire.raw()[1]).not.toContain('MSG-GX-001');
      expect(wire.saved().map(result => result.order_id)).toEqual(['SAMPLE-GX-001', 'SAMPLE-GX-ENC']);
    });
  });

  describe('classifies non-final outcomes', () => {
    it('stores an instrument error as Failed and keeps the detail in notes', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_ERROR));

      expect(wire.saved()[0]).toMatchObject({
        order_id: 'SAMPLE-GX-ERR',
        results: 'Failed',
        test_unit: '',
        notes: 'Error 2008: Probe check failed'
      });
    });

    it('stores a Roche instrument flag as Failed with the flag text in notes', () => {
      const wire = harness('roche-cobas-6800');

      wire.receive(mllp(ROCHE_6800_INSTRUMENT_ERROR));

      expect(wire.saved()[0]).toMatchObject({ results: 'Failed', notes: 'Clot detected' });
    });

    it('stores an in-progress observation as Incomplete', () => {
      const wire = harness();

      wire.receive(mllp(GENERIC_INCOMPLETE));

      expect(wire.saved()[0]).toMatchObject({ results: 'Incomplete', notes: 'In progress' });
    });
  });

  describe('rejects or contains non-conforming messages', () => {
    // Each analyzer has its own parser, and each has its own guard for these.
    for (const machineType of ['generic', 'abbott-alinity-m', 'roche-cobas-5800', 'roche-cobas-6800']) {
      it(`ACKs but does not store a message without a specimen (${machineType})`, () => {
        const wire = harness(machineType);

        wire.receive(mllp(MISSING_SPM));

        expect(wire.sent()).toHaveLength(1);
        expect(wire.saved()).toHaveLength(0);
        expect(wire.raw()).toHaveLength(1);
      });

      it(`ACKs but does not store a message without an observation (${machineType})`, () => {
        const wire = harness(machineType);

        wire.receive(mllp(MISSING_OBX));

        expect(wire.sent()).toHaveLength(1);
        expect(wire.saved()).toHaveLength(0);
        expect(wire.raw()).toHaveLength(1);
      });
    }

    it('survives a block that is not HL7 and still processes the next one', () => {
      const wire = harness();

      expect(() => wire.receive(mllp('NOT-HL7 AT ALL'))).not.toThrow();
      expect(() => wire.receive(mllp(''))).not.toThrow();
      wire.receive(mllp(GENERIC_HIV_VL));

      expect(wire.failures().filter(code => code === 'hl7_parse_failed')).toHaveLength(2);
      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0].order_id).toBe('SAMPLE-GX-001');
      expect(wire.connection.transmissionStatusSubject.value).toBe(false);
    });

    it('reports a persistence failure per result and keeps processing', () => {
      const wire = harness();
      wire.failPersistence();

      wire.receive(mllp(GENERIC_BATCH));

      expect(wire.saved()).toHaveLength(0);
      expect(wire.failures().filter(code => code === 'result_persistence_failed')).toHaveLength(3);
      expect(wire.sent()).toHaveLength(1);
    });

    it('drops an unfinished block when the instrument goes quiet', () => {
      vi.useFakeTimers();
      const wire = harness();

      wire.receive(VT + GENERIC_HIV_VL.slice(0, 40));
      vi.advanceTimersByTime(InstrumentInterfaceService.HL7_BUFFER_INACTIVITY_TIMEOUT_MS);
      wire.receive(GENERIC_HIV_VL.slice(40) + FS + CR);

      expect(wire.saved()).toHaveLength(0);
      expect(wire.failures()).toContain('incomplete_transmission_timeout');
      expect(wire.connection.transmissionStatusSubject.value).toBe(false);
    });

    it('drops an unfinished block that grows beyond the buffer limit', () => {
      const wire = harness();

      wire.receive(VT + 'MSH|' + 'X'.repeat(InstrumentInterfaceService.MAX_INCOMPLETE_HL7_BYTES));

      expect(wire.failures()).toContain('incomplete_transmission_too_large');
      expect((wire.service as any).hl7ReceiveBuffers.has('ANALYZER-1')).toBe(false);
    });

    it('clears partial state on disconnect so a reconnect starts clean', () => {
      const wire = harness();

      wire.receive(VT + GENERIC_HIV_VL.slice(0, 60));
      wire.disconnect();
      wire.receive(mllp(GENERIC_ENCODED_VALUE));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0].order_id).toBe('SAMPLE-GX-ENC');
      expect(wire.raw()[0]).not.toContain('MSG-GX-001');
    });
  });

  describe('keeps each specimen of a batch message to its own segments', () => {
    const specimen = (index: number, id: string, sacId: string, testCode: string, value: string) => [
      `SPM|${index}|${id}&ROCHE`,
      `SAC|||${sacId}`,
      `OBR|${index}|||${testCode}^${testCode}^99ROC`,
      obxSegment(index, { 2: 'ST', 3: `${testCode}^${testCode}^99ROC`, 4: '1.1', 5: value, 11: 'F', 16: 'TECH-1', 19: '20260714113000' })
    ];
    const batch = (groups: string[][]) => [msh('cobas 4800', 'MSG-BATCH'), ...groups.flat()].join(CR);
    const parsers = ['generic', 'roche-cobas-4800', 'roche-cobas-5800', 'roche-cobas-6800', 'abbott-alinity-m'];

    for (const machineType of parsers) {
      it(`never gives a specimen without an ID another specimen's ID (${machineType})`, () => {
        const wire = harness(machineType);

        wire.receive(mllp(batch([
          specimen(1, 'S-001', 'S-001', '0BHIV1', 'Target Not Detected'),
          specimen(2, '', '', '0BHIV1', 'Failed')
        ])));

        expect(wire.saved().filter(result => result.results === 'Failed').map(result => result.order_id)).toEqual(['']);
      });

      it(`never gives a specimen another specimen's result (${machineType})`, () => {
        const wire = harness(machineType);
        const withoutResult = specimen(2, 'S-002', 'S-002', '0BHIV1', '').slice(0, 3);

        wire.receive(mllp(batch([
          specimen(1, 'S-001', 'S-001', '0BHIV1', '4.12E+03 cp/mL'),
          withoutResult,
          specimen(3, 'S-003', 'S-003', '0BHIV1', 'Target Not Detected')
        ])));

        const stored = wire.saved().map(result => [result.order_id, result.results]);
        expect(stored).not.toContainEqual(['S-002', '4.12E+03 cp/mL']);
        expect(stored).not.toContainEqual(['S-002', 'Target Not Detected']);
        expect(stored).toContainEqual(['S-003', 'Target Not Detected']);
        expect(wire.failures()).toContain('result_parsing_failed');
      });

      it(`reads each specimen's test type from its own order (${machineType})`, () => {
        const wire = harness(machineType);

        wire.receive(mllp(batch([
          specimen(1, 'S-001', 'S-001', '0BHIV1', 'Target Not Detected'),
          specimen(2, 'S-002', 'S-002', '0BHIV1QUAL', 'Detected')
        ])));

        expect(wire.saved().map(result => [result.order_id, result.test_type])).toEqual([
          ['S-001', '0BHIV1'],
          ['S-002', '0BHIV1QUAL']
        ]);
      });
    }

    it('reads specimens listed before all of their results as a whole, as before', () => {
      const wire = harness();

      wire.receive(mllp([
        msh('Other', 'MSG-SPM-FIRST'),
        'SPM|1|S-001',
        'SPM|2|S-002',
        'OBR|1|||HIVVL^HIV-1 Viral Load',
        obxSegment(1, { 2: 'ST', 3: 'HIVVL^HIV-1 Viral Load', 4: '1', 5: '111', 11: 'F', 19: '20260714113000' }),
        obxSegment(2, { 2: 'ST', 3: 'HIVVL^HIV-1 Viral Load', 4: '2', 5: '222', 11: 'F', 19: '20260714113000' })
      ].join(CR)));

      expect(wire.saved().map(result => [result.order_id, result.results])).toEqual([['S-001', '111'], ['S-002', '222']]);
      expect(wire.failures()).toEqual([]);
    });

    for (const machineType of ['generic', 'roche-cobas-4800', 'roche-cobas-5800']) {
      it(`stores each specimen's own result when its group also carries a Ct value (${machineType})`, () => {
        const wire = harness(machineType);
        const withCt = (index: number, id: string, value: string, ct: string) => [
          `SPM|${index}|${id}`,
          `OBR|${index}|||0BHIV1^0BHIV1^99ROC`,
          obxSegment(1, { 2: 'DR', 3: 'RunTimeRange^Run Execution Time Range^99ROC', 4: '1', 5: '20260714100000^20260714113000', 11: 'F' }),
          obxSegment(2, { 2: 'ST', 3: '0BHIV1^0BHIV1^99ROC', 4: '1.1', 5: value, 11: 'F', 19: '20260714113000' }),
          obxSegment(3, { 2: 'ST', 3: '0BHIV1^0BHIV1^99ROC', 4: '1.2', 5: ct, 11: 'F', 19: '20260714113000' })
        ];

        wire.receive(mllp([
          msh('cobas', 'MSG-CT'),
          ...withCt(1, 'S-001', '111 cp/mL', '31.20'),
          ...withCt(2, 'S-002', '222 cp/mL', '29.80'),
          ...withCt(3, 'S-003', 'Target Not Detected', '0.00')
        ].join(CR)));

        expect(wire.saved().map(result => [result.order_id, result.results])).toEqual([
          ['S-001', '111 cp/mL'],
          ['S-002', '222 cp/mL'],
          ['S-003', 'Target Not Detected']
        ]);
      });
    }

    it('reads a specimen\'s test type from its own order rather than one before the specimens', () => {
      const wire = harness();

      wire.receive(mllp([
        msh('Other', 'MSG-HEADER-OBR'),
        'OBR|1|||HDR^HEADER',
        'SPM|1|S-001',
        'OBR|2|||A^ASSAY-A',
        obxSegment(1, { 2: 'ST', 3: 'A^ASSAY-A', 4: '1', 5: '111', 11: 'F', 19: '20260714113000' }),
        'SPM|2|S-002',
        'OBR|3|||B^ASSAY-B',
        obxSegment(2, { 2: 'ST', 3: 'B^ASSAY-B', 4: '2', 5: '222', 11: 'F', 19: '20260714113000' })
      ].join(CR)));

      expect(wire.saved().map(result => [result.order_id, result.test_type])).toEqual([['S-001', 'ASSAY-A'], ['S-002', 'ASSAY-B']]);
    });

    it('reads a message whose results come before its specimens as a whole, as before', () => {
      const wire = harness();

      wire.receive(mllp([
        msh('Other', 'MSG-ORU'),
        'OBR|1|||HIVVL^HIV-1 Viral Load',
        obxSegment(1, { 2: 'ST', 3: 'HIVVL^HIV-1 Viral Load', 4: '1', 5: '1250', 6: 'copies/mL', 11: 'F', 19: '20260714113000' }),
        obxSegment(2, { 2: 'ST', 3: 'HIVVL^HIV-1 Viral Load', 4: '2', 5: '820', 6: 'copies/mL', 11: 'F', 19: '20260714113000' }),
        'SPM|1|SAMPLE-ORU-001',
        'SPM|2|SAMPLE-ORU-002'
      ].join(CR)));

      expect(wire.saved().map(result => [result.order_id, result.results])).toEqual([
        ['SAMPLE-ORU-001', '1250'],
        ['SAMPLE-ORU-002', '820']
      ]);
    });
  });

  describe('isolates instruments', () => {
    it('keeps interleaved blocks from two analyzers apart', () => {
      const first = createWireHarness({ protocol: 'hl7', instrumentId: 'ANALYZER-A', port: 5001 });
      const second = createWireHarness({ protocol: 'hl7', instrumentId: 'ANALYZER-B', port: 5002, machineType: 'roche-cobas-6800' });

      first.receive(VT + GENERIC_HIV_VL.slice(0, 80));
      second.receive(VT + ROCHE_6800_QUANTIFIED.slice(0, 80));
      first.receive(GENERIC_HIV_VL.slice(80) + FS + CR);
      second.receive(ROCHE_6800_QUANTIFIED.slice(80) + FS + CR);

      expect(first.saved()[0].order_id).toBe('SAMPLE-GX-001');
      expect(second.saved()[0].order_id).toBe('SAMPLE-6800-001');
      expect(first.raw()[0]).not.toContain('6800');
      expect(second.raw()[0]).not.toContain('MSG-GX-001');
      expect(first.sent()).toHaveLength(1);
      expect(second.sent()).toHaveLength(1);
      expect(first.sent()[0]).not.toBe(ACK);
    });
  });
});
