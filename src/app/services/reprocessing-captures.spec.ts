/**
 * Reprocessing is how a result the tool once read wrongly is recovered: the
 * stored raw transmission is parsed again. That only works if parsing a stored
 * transmission produces exactly what parsing it live did.
 *
 * Each test receives a capture over the wire, takes the raw data that was
 * stored, reprocesses it as an operator would, and requires the same results,
 * field for field.
 */
import { describe, expect, it, vi } from 'vitest';
import { createWireHarness, mllp, ENQ, EOT, WireProtocol } from '../testing/wire-harness';
import { RawDataProcessorService } from './raw-data-processor.service';
import {
  M2000_HEADER, M2000_RUN_SAMPLES, m2000Frames, m2000Message, m2000Session
} from '../testing/fixtures/captured/abbott-m2000';
import { ALINITY_BATCH, alinityMessage } from '../testing/fixtures/captured/abbott-alinity-m';
import { COBAS_5800_CAPTURE } from '../testing/fixtures/captured/roche-cobas-5800';
import { COBAS_6800_CAPTURE } from '../testing/fixtures/captured/roche-cobas-6800';
import { COBAS_4800_RUN, cobas4800Run } from '../testing/fixtures/captured/roche-cobas-4800';
import { TAQMAN_SAMPLES, taqmanSession } from '../testing/fixtures/captured/roche-cobas-taqman';
import {
  GENEXPERT_FR_TESTS, GENEXPERT_TESTS, genexpertFrMessage, genexpertFrames, genexpertMessage
} from '../testing/fixtures/captured/cepheid-genexpert';

// Everything a result carries that came from the analyzer.
const RESULT_FIELDS = [
  'order_id', 'test_id', 'test_type', 'results', 'test_unit', 'result_status', 'notes', 'tested_by',
  'analysed_date_time', 'specimen_date_time', 'authorised_date_time', 'result_accepted_date_time',
  'machine_used', 'raw_text'
];

function project(results: any[]): any[] {
  return results.map(result => Object.fromEntries(RESULT_FIELDS.map(field => [field, result[field] ?? null])));
}

async function reprocess(protocol: WireProtocol, machineType: string, raw: string[]) {
  // A fresh interface with its own database, so nothing received live can
  // stand in for what reprocessing produces.
  const wire = createWireHarness({ protocol, machineType });
  const store = {
    get: vi.fn((key: string) => key === 'instrumentsConfig'
      ? [{
          analyzerMachineName: wire.connection.instrumentId,
          analyzerMachineType: machineType,
          interfaceCommunicationProtocol: protocol,
          labName: wire.connection.labName
        }]
      : {})
  };
  const processor = new RawDataProcessorService(wire.utilities, store as any, wire.service);
  const outcome = await processor.reprocessRawData(
    raw.map((data, index) => ({ id: index + 1, instrument_id: wire.connection.instrumentId, data }))
  );
  return { outcome, saved: wire.saved(), failures: wire.failures() };
}

interface Capture {
  name: string;
  protocol: WireProtocol;
  machineType: string;
  send: (receive: (bytes: string) => void) => void;
}

const astmSessions = (messages: string[][], frames: (records: string[]) => string[]) =>
  (receive: (bytes: string) => void) => {
    for (const message of messages) receive(ENQ + frames(message).join('') + EOT);
  };

const CAPTURES: Capture[] = [
  ...(['astm-checksum', 'astm-nonchecksum'] as const).map(protocol => ({
    name: `Abbott m2000 (${protocol})`,
    protocol,
    machineType: 'abbott-m2000',
    send: (receive: (bytes: string) => void) => receive(m2000Session(M2000_RUN_SAMPLES))
  })),
  ...(['astm-checksum', 'astm-nonchecksum'] as const).flatMap(protocol => [
    {
      name: `Cepheid GeneXpert (${protocol})`,
      protocol,
      machineType: 'cepheid-genexpert',
      send: astmSessions(GENEXPERT_TESTS.map(genexpertMessage), genexpertFrames)
    },
    {
      name: `Cepheid GeneXpert 6.5 French (${protocol})`,
      protocol,
      machineType: 'cepheid-genexpert',
      send: astmSessions(GENEXPERT_FR_TESTS.map(genexpertFrMessage), genexpertFrames)
    }
  ]),
  ...([['checksum', 'astm-checksum'], ['no-checksum', 'astm-nonchecksum']] as const).map(([framing, protocol]) => ({
    name: `Roche COBAS TaqMan 96 (${protocol})`,
    protocol,
    machineType: 'roche-cobas-taqman',
    send: (receive: (bytes: string) => void) => receive(taqmanSession(TAQMAN_SAMPLES, framing))
  })),
  {
    name: 'Abbott Alinity m (HL7)',
    protocol: 'hl7',
    machineType: 'abbott-alinity-m',
    send: receive => receive(ALINITY_BATCH.map(sample => mllp(alinityMessage(sample))).join(''))
  },
  {
    name: 'Roche cobas 5800 (HL7)',
    protocol: 'hl7',
    machineType: 'roche-cobas-5800',
    send: receive => COBAS_5800_CAPTURE.forEach(message => receive(mllp(message)))
  },
  {
    name: 'Roche cobas 6800/8800 (HL7)',
    protocol: 'hl7',
    machineType: 'roche-cobas-6800',
    send: receive => receive(COBAS_6800_CAPTURE.map(message => mllp(message)).join(''))
  },
  {
    // Some analyzers and serial-to-TCP bridges end segments with LF or CR LF.
    name: 'Abbott Alinity m, segments ended with CR LF (HL7)',
    protocol: 'hl7',
    machineType: 'abbott-alinity-m',
    send: receive => receive(ALINITY_BATCH.map(sample => mllp(alinityMessage(sample).replace(/\r/g, '\r\n'))).join(''))
  },
  {
    name: 'Roche cobas 4800 (HL7)',
    protocol: 'hl7',
    machineType: 'roche-cobas-4800',
    send: receive => receive(mllp(cobas4800Run('MSG-4800-RUN', COBAS_4800_RUN)))
  }
];

describe('reprocessing a stored capture', () => {
  for (const capture of CAPTURES) {
    it(`reproduces every live result exactly: ${capture.name}`, async () => {
      const live = createWireHarness({ protocol: capture.protocol, machineType: capture.machineType });
      capture.send(live.receive);
      expect(live.saved().length, 'the capture stores results live').toBeGreaterThan(0);

      const { outcome, saved, failures } = await reprocess(capture.protocol, capture.machineType, live.raw());

      expect(outcome).toEqual({ success: live.raw().length, failed: 0 });
      expect(failures).toEqual([]);
      expect(project(saved)).toEqual(project(live.saved()));
    });
  }
});

describe('reprocessing a run that also carries a message without an order', () => {
  // Seen in production m2000 runs: a message with a header and patient record
  // but no order between two complete ones. Live processing skips it. Read
  // back from raw data it was reported as a failed parse, although every
  // result came back identical.
  it('reproduces the results without reporting a failure', async () => {
    const messages = [
      m2000Message(M2000_RUN_SAMPLES[0]),
      [M2000_HEADER, 'P|1', 'L|1'],
      m2000Message(M2000_RUN_SAMPLES[1])
    ];
    const live = createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });
    live.receive(ENQ + m2000Frames(messages).join('') + EOT);
    expect(live.saved()).toHaveLength(2);

    const { outcome, saved, failures } = await reprocess('astm-checksum', 'abbott-m2000', live.raw());

    expect(outcome).toEqual({ success: 1, failed: 0 });
    expect(failures).toEqual([]);
    expect(project(saved)).toEqual(project(live.saved()));
  });
});

describe('reprocessing a transmission with an order that cannot be read', () => {
  it('reports the entry as not reprocessed', async () => {
    const live = createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });
    live.receive(m2000Session(M2000_RUN_SAMPLES.slice(0, 3)));

    const wire = createWireHarness({ protocol: 'astm-checksum', machineType: 'abbott-m2000' });
    const extract = wire.astmHelper.extractSampleResultFromASTM.bind(wire.astmHelper);
    vi.spyOn(wire.astmHelper, 'extractSampleResultFromASTM').mockImplementation((dataArray: any, partData: string) =>
      dataArray['O']?.[0]?.[2] === M2000_RUN_SAMPLES[1].specimenId ? null : extract(dataArray, partData)
    );
    const store = {
      get: vi.fn((key: string) => key === 'instrumentsConfig'
        ? [{ analyzerMachineName: wire.connection.instrumentId, analyzerMachineType: 'abbott-m2000', interfaceCommunicationProtocol: 'astm-checksum', labName: 'LAB001' }]
        : {})
    };
    const processor = new RawDataProcessorService(wire.utilities, store as any, wire.service);

    const outcome = await processor.reprocessRawData([{ id: 1, instrument_id: wire.connection.instrumentId, data: live.raw()[0] }]);

    expect(outcome).toEqual({ success: 0, failed: 1 });
    expect(wire.saved()).toHaveLength(2);
  });
});
