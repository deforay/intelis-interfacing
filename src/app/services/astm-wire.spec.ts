import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASTMHelperService } from './astm-helper.service';
import { UtilitiesService } from './utilities.service';
import {
  ACK, CR, ENQ, EOT, LF, NAK,
  astmContinuationFrames, astmFrame, astmFrames, astmSession, createWireHarness, e1381Checksum
} from '../testing/wire-harness';
import {
  ABBOTT_M2000_BATCH, ABBOTT_M2000_ENCODED_VALUE, ABBOTT_M2000_HEADER, ABBOTT_M2000_HIV_VL,
  ABBOTT_M2000_LONG_COMMENT, ABBOTT_M2000_NO_RESULT, GENEXPERT_HIV_VL_NOT_DETECTED,
  RUN_DATE_FORMATTED, TERMINATOR, orderRecord, resultRecord
} from '../testing/fixtures/astm.fixtures';

describe('ASTM over the wire (with checksum)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const harness = () => createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });

  describe('accepts conforming transmissions', () => {
    it('stores an Abbott m2000 viral load result with every field mapped', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames(ABBOTT_M2000_HIV_VL)));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({
        order_id: 'SAMPLE-M2000-001',
        test_id: 'SAMPLE-M2000-001',
        test_type: 'HIV1RNA',
        results: '1250',
        test_unit: 'copies/mL',
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
      expect(wire.saved()[0].raw_text).toContain('SAMPLE-M2000-001');
    });

    it('acknowledges ENQ, every frame and EOT exactly once each', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames(ABBOTT_M2000_HIV_VL)));

      expect(wire.sent()).toEqual(Array(ABBOTT_M2000_HIV_VL.length + 2).fill(ACK));
      expect(wire.connection.transmissionStatusSubject.value).toBe(false);
    });

    it('stores every frame of the transmission as raw data, marking where the message starts', () => {
      const wire = harness();
      const frames = astmFrames(ABBOTT_M2000_HIV_VL);

      wire.receive(astmSession(frames));

      expect(wire.raw()).toHaveLength(1);
      expect(wire.raw()[0]).toBe(wire.astmHelper.getStartMarker() + frames.join(''));
    });

    it('keeps a GeneXpert undetectable result as text and prefers the instrument specimen ID', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames(GENEXPERT_HIV_VL_NOT_DETECTED)));

      expect(wire.saved()[0]).toMatchObject({
        order_id: 'SAMPLE-GX-001',
        test_id: 'GX-RUN-77',
        test_type: 'HIV-1 VL',
        results: 'Target Not Detected',
        tested_by: 'TECH-2'
      });
    });

    it('stores one result per patient in a batch upload', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames(ABBOTT_M2000_BATCH)));

      expect(wire.saved().map(result => [result.order_id, result.results, result.result_status])).toEqual([
        ['SAMPLE-BATCH-001', '820', 1],
        ['SAMPLE-BATCH-002', 'Target Not Detected', 1],
        ['SAMPLE-BATCH-003', '15400', 0]
      ]);
    });

    it('reassembles a record sent across ETB continuation frames', () => {
      const wire = harness();
      const [header, patient, order, result, comment, terminator] = ABBOTT_M2000_LONG_COMMENT;
      const frames = [
        ...astmFrames([header, patient, order, result]),
        ...astmContinuationFrames(comment, 120, 5),
        ...astmFrames([terminator], 0)
      ];

      wire.receive(astmSession(frames));

      expect(wire.sent()).toEqual(Array(frames.length + 2).fill(ACK));
      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({ order_id: 'SAMPLE-M2000-LONG', results: '98765' });
      expect(wire.saved()[0].raw_text).toContain('Reagent lot 12345678 within expiry; calibration verified; '.repeat(6));
    });

    it('handles the same session delivered one byte at a time', () => {
      const wire = harness();
      const frames = astmFrames(ABBOTT_M2000_HIV_VL);

      wire.receiveInChunks(astmSession(frames), 1);

      expect(wire.sent()).toEqual(Array(ABBOTT_M2000_HIV_VL.length + 2).fill(ACK));
      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0].results).toBe('1250');
      // Byte by byte or all at once, the transmission stored is the same one.
      expect(wire.raw()[0]).toBe(wire.astmHelper.getStartMarker() + frames.join(''));
    });

    it('handles the whole session arriving in a single chunk and in odd-sized chunks', () => {
      for (const chunkSize of [7, 64, 4096]) {
        const wire = harness();
        wire.receiveInChunks(astmSession(astmFrames(ABBOTT_M2000_HIV_VL)), chunkSize);
        expect(wire.saved(), `chunk size ${chunkSize}`).toHaveLength(1);
        expect(wire.sent().filter(byte => byte === NAK), `chunk size ${chunkSize}`).toHaveLength(0);
      }
    });

    it('accepts frame numbers cycling through 7 to 0 within a long session', () => {
      const wire = harness();
      const records = [ABBOTT_M2000_HEADER];
      for (let sample = 1; sample <= 12; sample++) {
        records.push(`P|${sample}`, orderRecord(1, `SAMPLE-SEQ-${sample}`, '^^^HIV1RNA'), resultRecord(1, '^^^HIV1RNA', String(sample * 100), 'copies/mL'));
      }
      records.push(TERMINATOR);
      const frames = astmFrames(records);

      wire.receive(astmSession(frames));

      expect(frames.map(frame => frame.charAt(1)).slice(0, 9)).toEqual(['1', '2', '3', '4', '5', '6', '7', '0', '1']);
      expect(wire.sent().filter(byte => byte === NAK)).toHaveLength(0);
      expect(wire.saved()).toHaveLength(12);
    });

    it('accepts lowercase checksum digits and a frame ending in CR only', () => {
      const wire = harness();
      const body = ABBOTT_M2000_HEADER + CR;
      const lowercase = astmFrame(1, body, { checksum: e1381Checksum('1', body, '\x03').toLowerCase() });
      const rest = astmFrames(ABBOTT_M2000_HIV_VL.slice(1), 2).map(frame => frame.replace(/\r\n$/, CR));

      wire.receive(astmSession([lowercase, ...rest]));

      expect(wire.sent().filter(byte => byte === NAK)).toHaveLength(0);
      expect(wire.saved()).toHaveLength(1);
    });

    it('decodes HTML entities in result values', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames(ABBOTT_M2000_ENCODED_VALUE)));

      expect(wire.saved()[0].results).toBe('<40');
    });

    it('records a preliminary report as not final', () => {
      const wire = harness();
      const records = [ABBOTT_M2000_HEADER, 'P|1', orderRecord(1, 'SAMPLE-PRELIM', '^^^HIV1RNA', { status: 'P' }), resultRecord(1, '^^^HIV1RNA', '300', 'copies/mL'), TERMINATOR];

      wire.receive(astmSession(astmFrames(records)));

      expect(wire.saved()[0]).toMatchObject({ order_id: 'SAMPLE-PRELIM', result_status: 0 });
    });

    it('stores back-to-back sessions from the same instrument separately', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames(ABBOTT_M2000_HIV_VL)));
      wire.receive(astmSession(astmFrames(GENEXPERT_HIV_VL_NOT_DETECTED)));

      expect(wire.saved().map(result => result.order_id)).toEqual(['SAMPLE-M2000-001', 'SAMPLE-GX-001']);
      expect(wire.raw()).toHaveLength(2);
      expect(wire.raw()[1]).not.toContain('SAMPLE-M2000-001');
    });
  });

  describe('rejects or contains non-conforming transmissions', () => {
    it('NAKs a frame whose checksum does not match and never stores it', () => {
      const wire = harness();
      const [header, patient, order, result, terminator] = ABBOTT_M2000_HIV_VL;
      const corruptOrder = astmFrame(3, order + CR, { checksum: '00' });

      wire.receive(astmSession([...astmFrames([header, patient]), corruptOrder, ...astmFrames([result, terminator], 4)]));

      expect(wire.sent()).toEqual([ACK, ACK, ACK, NAK, ACK, ACK, ACK]);
      expect(wire.saved()).toHaveLength(0);
      expect(wire.raw()[0]).not.toContain('SAMPLE-M2000-001');
      expect(wire.failures()).toContain('checksum_mismatch');
    });

    it('NAKs a frame whose body was altered after the checksum was computed', () => {
      const wire = harness();
      const [header, patient, order, result, terminator] = ABBOTT_M2000_HIV_VL;
      const original = orderRecord(1, 'SAMPLE-M2000-001', '^^^HIV1RNA') + CR;
      const tampered = astmFrame(3, original.replace('001', '002'), { checksum: e1381Checksum('3', original, '\x03') });

      wire.receive(astmSession([...astmFrames([header, patient]), tampered, ...astmFrames([result, terminator], 4)]));

      expect(wire.sent()[3]).toBe(NAK);
      expect(wire.saved()).toHaveLength(0);
    });

    it('stores the result once the instrument retransmits a NAKed frame', () => {
      const wire = harness();
      const [header, patient, order, result, terminator] = ABBOTT_M2000_HIV_VL;

      wire.receive(ENQ);
      wire.receive(astmFrames([header, patient]).join(''));
      wire.receive(astmFrame(3, order + CR, { checksum: 'ZZ' }));
      wire.receive(astmFrame(3, order + CR));
      wire.receive(astmFrames([result, terminator], 4).join(''));
      wire.receive(EOT);

      expect(wire.sent()).toEqual([ACK, ACK, ACK, NAK, ACK, ACK, ACK, ACK]);
      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0].order_id).toBe('SAMPLE-M2000-001');
      expect(wire.raw()[0].match(/SAMPLE-M2000-001/g)).toHaveLength(1);
    });

    it('acknowledges a frame the instrument sends again without storing it twice', () => {
      const wire = harness();
      const [header, patient, order, result, terminator] = ABBOTT_M2000_HIV_VL;
      const orderFrame = astmFrame(3, order + CR);

      wire.receive(ENQ);
      wire.receive(astmFrames([header, patient]).join(''));
      // The frame arrives, our ACK does not reach the instrument, and it sends
      // the same frame again (E1381 section 6.3).
      wire.receive(orderFrame);
      wire.receive(orderFrame);
      wire.receive(astmFrames([result, terminator], 4).join(''));
      wire.receive(EOT);

      // Eight acknowledgements for eight things received, the repeat included:
      // ENQ, four frames, the frame again, the terminator frame, EOT.
      expect(wire.sent()).toEqual(Array(8).fill(ACK));
      expect(wire.sent()).not.toContain(NAK);
      // One order record means one order: a second copy of it would be an
      // order with no result records behind it, saved as a failure against a
      // sample that has a result.
      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({ order_id: 'SAMPLE-M2000-001', results: '1250' });

      // The repeat is left out of the stored transmission on purpose. Framing
      // is gone by the time raw_data is read back, so a second copy of the
      // record in there is indistinguishable from a second order, and
      // reprocessing would save the failure row this fix exists to prevent.
      expect(wire.raw()[0].match(/SAMPLE-M2000-001/g)).toHaveLength(1);

      const utilities = new UtilitiesService(null, null, { log: vi.fn() } as any);
      const reprocessed = utilities.removeControlCharacters(wire.raw()[0], true)
        .split(wire.astmHelper.getStartMarker())
        .filter(Boolean)
        .flatMap(part => wire.astmHelper.splitASTMRecordsByOrder(part.split(/<CR>/)));
      expect(reprocessed).toHaveLength(1);
    });

    it('does not acknowledge a frame until its checksum has arrived', () => {
      const wire = harness();
      const frame = astmFrames([ABBOTT_M2000_HEADER])[0];

      wire.receive(ENQ);
      wire.receive(frame.slice(0, -4));
      expect(wire.sent()).toEqual([ACK]);

      wire.receive(frame.slice(-4));
      expect(wire.sent()).toEqual([ACK, ACK]);
    });

    it('records a transmission that carries no order as a failure without inventing a result', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames([ABBOTT_M2000_HEADER, 'P|1', TERMINATOR])));

      expect(wire.saved()).toHaveLength(0);
      expect(wire.failures()).toContain('no_results_extracted');
      expect(wire.raw()).toHaveLength(1);
    });

    it('stores an order without a result as Failed', () => {
      const wire = harness();

      wire.receive(astmSession(astmFrames(ABBOTT_M2000_NO_RESULT)));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0]).toMatchObject({
        order_id: 'SAMPLE-M2000-ERR',
        results: 'Failed',
        test_unit: null,
        result_status: 0
      });
    });

    it('tolerates EOT with nothing before it', () => {
      const wire = harness();

      wire.receive(ENQ + EOT);
      wire.receive(astmSession(astmFrames(ABBOTT_M2000_HIV_VL)));

      expect(wire.raw()).toHaveLength(1);
      expect(wire.saved()).toHaveLength(1);
    });

    it('responds to a NAK from the instrument without corrupting the next session', () => {
      const wire = harness();

      wire.receive(NAK);
      wire.receive(astmSession(astmFrames(ABBOTT_M2000_HIV_VL)));

      expect(wire.failures()).toContain('instrument_nak');
      expect(wire.saved()).toHaveLength(1);
    });

    it('passes unframed text through and still frames what follows', () => {
      const wire = harness();
      const frames = astmFrames(ABBOTT_M2000_HIV_VL);

      wire.receive(ENQ + 'READY' + CR + LF + frames.join('') + EOT);

      expect(wire.sent().filter(byte => byte === NAK)).toHaveLength(0);
      expect(wire.saved()).toHaveLength(1);
    });

    it('reports a persistence failure per result and keeps processing', () => {
      const wire = harness();
      wire.failPersistence();

      wire.receive(astmSession(astmFrames(ABBOTT_M2000_BATCH)));

      expect(wire.saved()).toHaveLength(0);
      expect(wire.failures().filter(code => code === 'result_persistence_failed')).toHaveLength(3);
    });

    it('drops an unfinished frame when the instrument goes quiet and starts the next session clean', () => {
      vi.useFakeTimers();
      const wire = harness();
      const frame = astmFrames([ABBOTT_M2000_HEADER])[0];

      wire.receive(ENQ + frame.slice(0, 10));
      vi.advanceTimersByTime(ASTMHelperService.BUFFER_INACTIVITY_TIMEOUT_MS);

      expect(wire.connection.transmissionStatusSubject.value).toBe(false);
      expect((wire.astmHelper as any).astmFrameBuffers.has('ANALYZER-1')).toBe(false);
      expect(wire.sent()).toEqual([ACK]);

      wire.receive(astmSession(astmFrames(GENEXPERT_HIV_VL_NOT_DETECTED)));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.raw()[0]).not.toContain('m2000');
    });

    it('drops an unfinished frame that grows beyond the buffer limit', () => {
      const wire = harness();

      wire.receive('\x02' + '1' + 'X'.repeat(ASTMHelperService.MAX_INCOMPLETE_BUFFER_BYTES + 1));

      expect(wire.connection.transmissionStatusSubject.value).toBe(false);
      expect((wire.astmHelper as any).astmFrameBuffers.has('ANALYZER-1')).toBe(false);
      // Several megabytes pass through the byte-by-byte decoding, which takes
      // longer than the default timeout on a busy machine.
    }, 30_000);

    it('clears partial state on disconnect so a reconnect starts clean', () => {
      const wire = harness();
      const frames = astmFrames(ABBOTT_M2000_HIV_VL);

      wire.receive(ENQ + frames.slice(0, 3).join(''));
      wire.disconnect();
      wire.receive(astmSession(astmFrames(GENEXPERT_HIV_VL_NOT_DETECTED)));

      expect(wire.saved()).toHaveLength(1);
      expect(wire.saved()[0].order_id).toBe('SAMPLE-GX-001');
      expect(wire.raw()[0]).not.toContain('SAMPLE-M2000-001');
    });
  });

  describe('isolates instruments', () => {
    it('keeps interleaved frames from two analyzers apart', () => {
      const first = createWireHarness({ protocol: 'astm-checksum', instrumentId: 'ANALYZER-A', port: 5001 });
      const second = createWireHarness({ protocol: 'astm-checksum', instrumentId: 'ANALYZER-B', port: 5002 });
      const framesA = astmFrames(ABBOTT_M2000_HIV_VL);
      const framesB = astmFrames(GENEXPERT_HIV_VL_NOT_DETECTED);

      first.receive(ENQ + framesA[0]);
      second.receive(ENQ + framesB[0] + framesB[1]);
      first.receive(framesA.slice(1).join(''));
      second.receive(framesB.slice(2).join('') + EOT);
      first.receive(EOT);

      expect(second.saved()[0].order_id).toBe('SAMPLE-GX-001');
      expect(first.saved()[0].order_id).toBe('SAMPLE-M2000-001');
      expect(first.raw()[0]).not.toContain('SAMPLE-GX-001');
      expect(second.raw()[0]).not.toContain('SAMPLE-M2000-001');
    });
  });
});

describe('ASTM over the wire (without checksum)', () => {
  const harness = () => createWireHarness({ protocol: 'astm-nonchecksum', machineType: 'roche-elecsys' });

  // Without checksums there is no frame boundary to detect, so an analyzer in
  // this mode is expected to send each frame, and the final EOT, as its own
  // chunk and wait for the ACK, which is how E1381 sessions run anyway.
  const sendSession = (wire: ReturnType<typeof harness>, frames: string[]) => {
    wire.receive(ENQ);
    for (const frame of frames) {
      wire.receive(frame);
    }
    wire.receive(EOT);
  };

  it('stores a result from frames that carry no checksum at all', () => {
    const wire = harness();
    const frames = ABBOTT_M2000_HIV_VL.map((record, index) => `\x02${(index + 1) % 8}${record}${CR}\x03${CR}${LF}`);

    sendSession(wire, frames);

    expect(wire.sent()).toEqual(Array(frames.length + 2).fill(ACK));
    expect(wire.saved()).toHaveLength(1);
    expect(wire.saved()[0]).toMatchObject({ order_id: 'SAMPLE-M2000-001', results: '1250', test_unit: 'copies/mL' });
  });

  it('stores a result from bare records with no framing bytes', () => {
    const wire = harness();

    wire.receive(ABBOTT_M2000_HIV_VL.join(CR) + CR);
    wire.receive(EOT);

    expect(wire.saved()).toHaveLength(1);
    expect(wire.saved()[0].order_id).toBe('SAMPLE-M2000-001');
  });

  it('never sends NAK, even for frames whose checksum digits are wrong', () => {
    const wire = harness();
    const frames = ABBOTT_M2000_HIV_VL.map((record, index) => astmFrame(index + 1, record + CR, { checksum: 'ZZ' }));

    sendSession(wire, frames);

    expect(wire.sent()).not.toContain(NAK);
    expect(wire.saved()).toHaveLength(1);
  });

  it('stores one result per patient in a batch upload', () => {
    const wire = harness();

    wire.receive(ABBOTT_M2000_BATCH.join(CR) + CR);
    wire.receive(EOT);

    expect(wire.saved().map(result => result.order_id)).toEqual(['SAMPLE-BATCH-001', 'SAMPLE-BATCH-002', 'SAMPLE-BATCH-003']);
  });
});
