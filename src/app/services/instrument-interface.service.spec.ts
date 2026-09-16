import { BehaviorSubject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstrumentInterfaceService } from './instrument-interface.service';
import { HL7HelperService } from './hl7-helper.service';
import { ASTMHelperService } from './astm-helper.service';
import { UtilitiesService } from './utilities.service';

describe('InstrumentInterfaceService HL7 streams', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const createConnection = (instrumentId: string) => ({
    connectionProtocol: 'hl7',
    instrumentId,
    machineType: 'generic',
    labName: 'LAB001',
    statusSubject: new BehaviorSubject(false),
    connectionAttemptStatusSubject: new BehaviorSubject(false),
    transmissionStatusSubject: new BehaviorSubject(false),
    errorOccurred: false,
    reconnectAttempts: 0
  });

  const createService = () => {
    const dbService = {
      recordRawData: vi.fn((_data, success) => success())
    };
    const tcpService = {
      connectionStack: new Map<string, any>(),
      disconnect: vi.fn()
    };
    const utilitiesService = {
      hex2ascii: (hex: string) => Buffer.from(hex, 'hex').toString('binary'),
      logger: vi.fn()
    };
    const astmHelper = {
      clearInstrumentBuffer: vi.fn()
    };
    const service = new InstrumentInterfaceService(
      dbService as any,
      tcpService as any,
      utilitiesService as any,
      new HL7HelperService(utilitiesService as any),
      astmHelper as any
    );

    return { service, dbService, tcpService, astmHelper };
  };

  const createParsingService = (persistenceSucceeds: boolean) => {
    const loggingService = { log: vi.fn() };
    const utilities = new UtilitiesService(null, null, loggingService as any);
    const dbService = {
      recordTestResults: vi.fn((_data, success, failure) => {
        if (persistenceSucceeds) success({ lastID: 1 });
        else failure(new Error('database write failed'));
      }),
      recordTelemetryEvent: vi.fn().mockResolvedValue(true)
    };
    const hl7Helper = new HL7HelperService(utilities);
    const astmHelper = new ASTMHelperService(utilities);
    const service = new InstrumentInterfaceService(
      dbService as any,
      { connectionStack: new Map() } as any,
      utilities,
      hl7Helper,
      astmHelper
    );

    return { service, dbService };
  };

  it('does not mix fragmented HL7 messages from concurrent instruments', () => {
    vi.useFakeTimers();
    const { service, dbService, tcpService } = createService();
    const keyA = '10.0.0.1:5001:tcpserver:hl7';
    const keyB = '10.0.0.2:5002:tcpserver:hl7';
    tcpService.connectionStack.set(keyA, createConnection('ANALYZER-A'));
    tcpService.connectionStack.set(keyB, createConnection('ANALYZER-B'));
    const processSpy = vi.spyOn(service, 'processHL7Data').mockImplementation(() => undefined);

    service.handleTCPResponse(keyA, Buffer.from('MSH|^~\\&|A|LAB|'));
    service.handleTCPResponse(keyB, Buffer.from('MSH|^~\\&|B|LAB|RESULT-B\x1c'));
    service.handleTCPResponse(keyA, Buffer.from('RESULT-A\x1c'));
    // Neither analyzer ends its block with <CR>, so both are taken once the
    // grace for it has passed, in the order they arrived.
    vi.advanceTimersByTime(InstrumentInterfaceService.MLLP_TERMINATOR_GRACE_MS);

    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy.mock.calls[0][1]).toContain('RESULT-B');
    expect(processSpy.mock.calls[0][1]).not.toContain('|A|LAB|');
    expect(processSpy.mock.calls[1][1]).toContain('RESULT-A');
    expect(processSpy.mock.calls[1][1]).not.toContain('|B|LAB|');

    const rawMessages = dbService.recordRawData.mock.calls.map(call => call[0].data);
    expect(rawMessages[0]).toContain('RESULT-B');
    expect(rawMessages[0]).not.toContain('|A|LAB|');
    expect(rawMessages[1]).toContain('RESULT-A');
    expect(rawMessages[1]).not.toContain('|B|LAB|');
  });

  it('keeps an incomplete HL7 frame buffered without parsing or persistence', () => {
    const { service, dbService, tcpService } = createService();
    const key = '10.0.0.1:5001:tcpserver:hl7';
    tcpService.connectionStack.set(key, createConnection('ANALYZER-A'));
    const processSpy = vi.spyOn(service, 'processHL7Data').mockImplementation(() => undefined);

    service.handleTCPResponse(key, Buffer.from('MSH|^~\\&|A|LAB|PARTIAL'));

    expect(processSpy).not.toHaveBeenCalled();
    expect(dbService.recordRawData).not.toHaveBeenCalled();
  });

  it('isolates a malformed completed frame from the following transmission', () => {
    vi.useFakeTimers();
    const { service, tcpService } = createService();
    const key = '10.0.0.1:5001:tcpserver:hl7';
    tcpService.connectionStack.set(key, createConnection('ANALYZER-A'));
    const processSpy = vi.spyOn(service, 'processHL7Data').mockImplementation(() => undefined);

    service.handleTCPResponse(key, Buffer.from('NOT-HL7\x1c'));
    service.handleTCPResponse(key, Buffer.from('MSH|^~\\&|A|LAB|VALID\x1c'));
    // Neither block carries the <CR> that ends an MLLP block, so the last one
    // is taken once the grace for it has passed.
    vi.advanceTimersByTime(InstrumentInterfaceService.MLLP_TERMINATOR_GRACE_MS);

    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy.mock.calls[1][1]).not.toContain('NOT-HL7');
  });

  it('discards an oversized incomplete HL7 frame', () => {
    const { service, tcpService } = createService();
    const key = '10.0.0.1:5001:tcpserver:hl7';
    const instrument = createConnection('ANALYZER-A');
    tcpService.connectionStack.set(key, instrument);
    const maximumBytes = InstrumentInterfaceService.MAX_INCOMPLETE_HL7_BYTES;

    service.handleTCPResponse(key, Buffer.from(`MSH|^~\\&|A|LAB|${'X'.repeat(maximumBytes)}`));

    expect((service as any).hl7ReceiveBuffers.has('ANALYZER-A')).toBe(false);
    expect(instrument.transmissionStatusSubject.value).toBe(false);
  });

  it('discards an inactive incomplete HL7 frame', () => {
    vi.useFakeTimers();
    const { service, tcpService } = createService();
    const key = '10.0.0.1:5001:tcpserver:hl7';
    const instrument = createConnection('ANALYZER-A');
    tcpService.connectionStack.set(key, instrument);

    service.handleTCPResponse(key, Buffer.from('MSH|^~\\&|A|LAB|PARTIAL'));
    vi.advanceTimersByTime(InstrumentInterfaceService.HL7_BUFFER_INACTIVITY_TIMEOUT_MS);

    expect((service as any).hl7ReceiveBuffers.has('ANALYZER-A')).toBe(false);
    expect(instrument.transmissionStatusSubject.value).toBe(false);
  });

  it('clears incomplete protocol state when an instrument disconnects', () => {
    const { service, tcpService, astmHelper } = createService();
    const key = '10.0.0.1:5001:tcpserver:hl7';
    tcpService.connectionStack.set(key, createConnection('ANALYZER-A'));
    service.handleTCPResponse(key, Buffer.from('MSH|^~\\&|A|LAB|PARTIAL'));

    service.disconnect({
      connectionParams: {
        instrumentId: 'ANALYZER-A',
        host: '10.0.0.1',
        port: 5001
      }
    });

    expect((service as any).hl7ReceiveBuffers.has('ANALYZER-A')).toBe(false);
    expect(astmHelper.clearInstrumentBuffer).toHaveBeenCalledWith('ANALYZER-A');
    expect(tcpService.disconnect).toHaveBeenCalledOnce();
  });

  it('processes every MLLP block when several arrive in one chunk', () => {
    const { service, tcpService } = createService();
    const key = '10.0.0.1:5001:tcpserver:hl7';
    tcpService.connectionStack.set(key, createConnection('ANALYZER-A'));
    const processSpy = vi.spyOn(service, 'processHL7Data').mockImplementation(() => undefined);

    service.handleTCPResponse(key, Buffer.from('\x0bMSH|^~\\&|A|LAB|FIRST\x1c\r\x0bMSH|^~\\&|A|LAB|SECOND\x1c\r'));

    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy.mock.calls[0][1]).toContain('FIRST');
    expect(processSpy.mock.calls[0][1]).not.toContain('SECOND');
    expect(processSpy.mock.calls[1][1]).toContain('SECOND');
    expect(processSpy.mock.calls[1][1]).not.toContain('FIRST');
  });

  it('keeps the tail after a block separator for the next message', () => {
    const { service, tcpService } = createService();
    const key = '10.0.0.1:5001:tcpserver:hl7';
    tcpService.connectionStack.set(key, createConnection('ANALYZER-A'));
    const processSpy = vi.spyOn(service, 'processHL7Data').mockImplementation(() => undefined);

    service.handleTCPResponse(key, Buffer.from('\x0bMSH|^~\\&|A|LAB|FIRST\x1c'));
    service.handleTCPResponse(key, Buffer.from('\r\x0bMSH|^~\\&|A|LAB|SEC'));
    service.handleTCPResponse(key, Buffer.from('OND\x1c\r'));

    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(processSpy.mock.calls[1][1]).toContain('SECOND');
    expect(processSpy.mock.calls[1][1]).not.toContain('FIRST');
    expect((service as any).hl7ReceiveBuffers.has('ANALYZER-A')).toBe(false);
  });

  it('reports successful persistence after parsing a stored HL7 result', async () => {
    const { service, dbService } = createParsingService(true);
    const rawMessage = [
      'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-001|P|2.5.1',
      'SPM|1|SAMPLE-001',
      'OBR|1|||HIVVL^HIV Viral Load',
      'OBX|1|ST|HIVVL^HIV Viral Load|1|1250|copies/mL|||||F|||||TECH-1|||20260714113000'
    ].join('\r');

    const outcomes = await service.processHL7Data(createConnection('ANALYZER-A') as any, rawMessage);

    expect(outcomes).toEqual([true]);
    expect(dbService.recordTestResults).toHaveBeenCalledOnce();
  });

  it('reports persistence failure after parsing a stored HL7 result', async () => {
    const { service, dbService } = createParsingService(false);
    const rawMessage = [
      'MSH|^~\\&|ANALYZER|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-002|P|2.5.1',
      'SPM|1|SAMPLE-002',
      'OBR|1|||HIVVL^HIV Viral Load',
      'OBX|1|ST|HIVVL^HIV Viral Load|1|Failed|||||||X'
    ].join('\r');

    const outcomes = await service.processHL7Data(createConnection('ANALYZER-A') as any, rawMessage);

    expect(outcomes).toEqual([false]);
    expect(dbService.recordTelemetryEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'test.processing_failed',
      instrumentId: 'ANALYZER-A',
      testType: 'HIV Viral Load',
      outcome: 'failed',
      failureCode: 'result_persistence_failed'
    }));
    expect(dbService.recordTelemetryEvent.mock.calls[0][0]).not.toHaveProperty('orderId');
    expect(dbService.recordTelemetryEvent.mock.calls[0][0]).not.toHaveProperty('result');
  });
});

describe('InstrumentInterfaceService ASTM frames', () => {
  const createConnection = (instrumentId: string) => ({
    instrumentId,
    machineType: 'generic',
    labName: 'LAB001',
    statusSubject: new BehaviorSubject(false),
    connectionAttemptStatusSubject: new BehaviorSubject(false),
    transmissionStatusSubject: new BehaviorSubject(false),
    errorOccurred: false,
    reconnectAttempts: 0
  });

  const createASTMService = (protocol: 'astm-checksum' | 'astm-nonchecksum') => {
    const dbService = {
      recordRawData: vi.fn((_data, success) => success()),
      recordTestResults: vi.fn((_data, success) => success({ lastID: 1 })),
      recordTelemetryEvent: vi.fn().mockResolvedValue(true)
    };
    const tcpService = { connectionStack: new Map<string, any>(), disconnect: vi.fn() };
    const utilities = new UtilitiesService(null, null, { log: vi.fn() } as any);
    const astmHelper = new ASTMHelperService(utilities);
    const service = new InstrumentInterfaceService(
      dbService as any,
      tcpService as any,
      utilities,
      new HL7HelperService(utilities),
      astmHelper
    );
    const socket = { writable: true, write: vi.fn() };
    const key = `10.0.0.1:5001:tcpserver:${protocol}`;
    tcpService.connectionStack.set(key, {
      ...createConnection('ANALYZER-A'),
      connectionProtocol: protocol,
      connectionSocket: socket
    });
    const sentBytes = () => socket.write.mock.calls.map(call => call[0].toString('binary'));
    const frame = (body: string, checksum?: string) => {
      const unchecked = `\x02${body}\x03`;
      return `${unchecked}${checksum ?? astmHelper.calculateChecksum(unchecked)}\r\n`;
    };

    return { service, dbService, key, sentBytes, frame };
  };

  const ACK = '\x06';
  const NAK = '\x15';
  const ENQ = '\x05';
  const EOT = '\x04';
  const header = '1H|\\^&|||LAB001\r';
  const order = '2O|1|SAMPLE-001||^^^HIVVL|||||||||||||||||||||F\r';
  const result = '3R|1|^^^HIVVL|1250|copies/mL\r';

  it('acknowledges frames with a valid checksum and stores the result', () => {
    const { service, dbService, key, sentBytes, frame } = createASTMService('astm-checksum');

    service.handleTCPResponse(key, Buffer.from(ENQ, 'binary'));
    service.handleTCPResponse(key, Buffer.from(frame(header), 'binary'));
    service.handleTCPResponse(key, Buffer.from(frame(order) + frame(result), 'binary'));
    service.handleTCPResponse(key, Buffer.from(EOT, 'binary'));

    expect(sentBytes()).toEqual([ACK, ACK, ACK, ACK, ACK]);
    expect(dbService.recordTestResults).toHaveBeenCalledOnce();
    expect(dbService.recordTestResults.mock.calls[0][0]).toMatchObject({ order_id: 'SAMPLE-001', results: '1250' });
  });

  it('rejects a corrupt frame with NAK and accepts the retransmission', () => {
    const { service, dbService, key, sentBytes, frame } = createASTMService('astm-checksum');

    service.handleTCPResponse(key, Buffer.from(frame(header), 'binary'));
    service.handleTCPResponse(key, Buffer.from(frame(order, '00'), 'binary'));
    service.handleTCPResponse(key, Buffer.from(frame(order), 'binary'));
    service.handleTCPResponse(key, Buffer.from(frame(result), 'binary'));
    service.handleTCPResponse(key, Buffer.from(EOT, 'binary'));

    expect(sentBytes()).toEqual([ACK, NAK, ACK, ACK, ACK]);
    expect(dbService.recordTestResults).toHaveBeenCalledOnce();
    expect(dbService.recordRawData.mock.calls[0][0].data.match(/O\|1\|SAMPLE-001/g)).toHaveLength(1);
    expect(dbService.recordTelemetryEvent).toHaveBeenCalledWith(expect.objectContaining({ failureCode: 'checksum_mismatch' }));
  });

  it('waits for the rest of a frame split across TCP chunks before acknowledging', () => {
    const { service, dbService, key, sentBytes, frame } = createASTMService('astm-checksum');
    const framed = frame(header);
    const splitAt = 8;

    service.handleTCPResponse(key, Buffer.from(framed.slice(0, splitAt), 'binary'));
    expect(sentBytes()).toEqual([]);

    service.handleTCPResponse(key, Buffer.from(framed.slice(splitAt), 'binary'));
    service.handleTCPResponse(key, Buffer.from(frame(order) + frame(result), 'binary'));
    service.handleTCPResponse(key, Buffer.from(EOT, 'binary'));

    expect(sentBytes()).toEqual([ACK, ACK, ACK, ACK]);
    expect(dbService.recordTestResults).toHaveBeenCalledOnce();
  });

  it('keeps accepting unverified frames when the protocol has no checksum', () => {
    const { service, dbService, key, sentBytes, frame } = createASTMService('astm-nonchecksum');

    service.handleTCPResponse(key, Buffer.from(frame(header), 'binary'));
    service.handleTCPResponse(key, Buffer.from(frame(order, '00') + frame(result, 'ZZ'), 'binary'));
    service.handleTCPResponse(key, Buffer.from(EOT, 'binary'));

    // One ACK per frame, as E1381 has it, even when two frames share a read.
    expect(sentBytes()).toEqual([ACK, ACK, ACK, ACK]);
    expect(sentBytes()).not.toContain(NAK);
    expect(dbService.recordTestResults).toHaveBeenCalledOnce();
  });
});
