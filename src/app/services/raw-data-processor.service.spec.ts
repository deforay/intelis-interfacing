import { describe, expect, it, vi } from 'vitest';
import { RawDataProcessorService } from './raw-data-processor.service';

describe('RawDataProcessorService', () => {
  const configuredInstrument = {
    analyzerMachineName: 'ANALYZER-1',
    analyzerMachineType: 'generic',
    interfaceCommunicationProtocol: 'hl7',
    labName: 'LAB001'
  };

  const createService = () => {
    const utilities = { logger: vi.fn() };
    const store = {
      get: vi.fn((key: string) => key === 'instrumentsConfig' ? [configuredInstrument] : {})
    };
    const instrumentInterface = {
      hl7Helper: { unwrapMLLPBlock: vi.fn((block: string) => block) },
      processHL7Data: vi.fn().mockResolvedValue([true]),
      processHL7DataAlinity: vi.fn().mockResolvedValue([true]),
      processHL7DataRoche5800: vi.fn().mockResolvedValue([true]),
      processHL7DataRoche68008800: vi.fn().mockResolvedValue([true])
    };
    const service = new RawDataProcessorService(
      utilities as any,
      store as any,
      instrumentInterface as any
    );

    return { service, instrumentInterface };
  };

  it('uses the matching instrument profile when reprocessing stored HL7', async () => {
    const { service, instrumentInterface } = createService();
    const rawData = 'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-001|P|2.5.1';

    const result = await service.reprocessRawData([{
      id: 1,
      instrument_id: 'ANALYZER-1',
      data: rawData
    }]);

    expect(result).toEqual({ success: 1, failed: 0 });
    expect(instrumentInterface.processHL7Data).toHaveBeenCalledOnce();
    expect(instrumentInterface.processHL7Data.mock.calls[0][0].instrumentId).toBe('ANALYZER-1');
    expect(instrumentInterface.processHL7Data.mock.calls[0][1]).toBe(rawData);
  });

  it('refuses to reprocess data when no instrument profile matches', async () => {
    const { service, instrumentInterface } = createService();

    const result = await service.reprocessRawData([{
      id: 2,
      instrument_id: 'UNKNOWN-ANALYZER',
      data: 'MSH|^~\\&|UNKNOWN|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-002|P|2.5.1'
    }]);

    expect(result).toEqual({ success: 0, failed: 1 });
    expect(instrumentInterface.processHL7Data).not.toHaveBeenCalled();
  });

  it('reports failure when parsing produces no persisted results', async () => {
    const { service, instrumentInterface } = createService();
    instrumentInterface.processHL7Data.mockResolvedValue([]);

    const result = await service.reprocessRawData([{
      id: 3,
      instrument_id: 'ANALYZER-1',
      data: 'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-003|P|2.5.1'
    }]);

    expect(result).toEqual({ success: 0, failed: 1 });
  });

  it('reports failure when a reprocessed result cannot be persisted', async () => {
    const { service, instrumentInterface } = createService();
    instrumentInterface.processHL7Data.mockResolvedValue([false]);

    const result = await service.reprocessRawData([{
      id: 4,
      instrument_id: 'ANALYZER-1',
      data: 'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-004|P|2.5.1'
    }]);

    expect(result).toEqual({ success: 0, failed: 1 });
  });
});
