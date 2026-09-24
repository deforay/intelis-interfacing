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
      processHL7Message: vi.fn().mockResolvedValue([true])
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

    expect(result).toMatchObject({ success: 1, failed: 0 });
    expect(instrumentInterface.processHL7Message).toHaveBeenCalledOnce();
    expect(instrumentInterface.processHL7Message.mock.calls[0][0].instrumentId).toBe('ANALYZER-1');
    expect(instrumentInterface.processHL7Message.mock.calls[0][1]).toBe(rawData);
  });

  it('reports a run that stops because the raw data cannot be read as stopped, not complete', async () => {
    const { service, instrumentInterface } = createService();
    const message = 'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-001|P|2.5.1';
    let batches = 0;
    (instrumentInterface as any).dbService = {
      countRawData: vi.fn().mockResolvedValue(3),
      nextRawDataBatch: vi.fn(async (_store, _filter, _afterId, _limit, order) => {
        if (order === 'desc') {
          return [{ id: 3 }];
        }
        if (++batches === 1) {
          return [{ id: 1, instrument_id: 'ANALYZER-1', data: message }];
        }
        throw new Error('MySQL connection lost');
      })
    };

    const status = await service.reprocessMatching('mysql', {});

    expect(status).toMatchObject({
      success: 1,
      failed: 0,
      processedCount: 1,
      totalCount: 3,
      cancelled: false,
      stoppedBy: 'Could not read raw data: MySQL connection lost',
      currentItem: 'Reprocessing stopped'
    });
  });

  it('refuses to reprocess data when no instrument profile matches', async () => {
    const { service, instrumentInterface } = createService();

    const result = await service.reprocessRawData([{
      id: 2,
      instrument_id: 'UNKNOWN-ANALYZER',
      data: 'MSH|^~\\&|UNKNOWN|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-002|P|2.5.1'
    }]);

    expect(result).toMatchObject({ success: 0, failed: 1 });
    expect(instrumentInterface.processHL7Message).not.toHaveBeenCalled();
  });

  it('reports failure when a message with results produces no persisted results', async () => {
    const { service, instrumentInterface } = createService();
    instrumentInterface.processHL7Message.mockResolvedValue([]);

    const result = await service.reprocessRawData([{
      id: 3,
      instrument_id: 'ANALYZER-1',
      data: 'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-003|P|2.5.1\rOBX|1|NM|HIV||1250'
    }]);

    expect(result).toMatchObject({ success: 0, empty: 0, failed: 1 });
  });

  it('counts a message with no result segments as holding no results, not as a failure', async () => {
    const { service, instrumentInterface } = createService();
    instrumentInterface.processHL7Message.mockResolvedValue([]);

    const result = await service.reprocessRawData([{
      id: 5,
      instrument_id: 'ANALYZER-1',
      data: 'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||QBP^Q11^QBP_Q11|MSG-005|P|2.5.1\rQPD|WOS^Work Order Step^IHELAW|Q-1|VL0001'
    }]);

    expect(result).toMatchObject({ success: 0, empty: 1, failed: 0 });
  });

  it('reports failure when a reprocessed result cannot be persisted', async () => {
    const { service, instrumentInterface } = createService();
    instrumentInterface.processHL7Message.mockResolvedValue([false]);

    const result = await service.reprocessRawData([{
      id: 4,
      instrument_id: 'ANALYZER-1',
      data: 'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-004|P|2.5.1'
    }]);

    expect(result).toMatchObject({ success: 0, failed: 1 });
  });
});
