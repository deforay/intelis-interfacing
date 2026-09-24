/**
 * Wire-level test harness for the instrument interface.
 *
 * Feeds raw bytes into InstrumentInterfaceService exactly as the TCP layer
 * would, using the real ASTM and HL7 helpers and a fake socket and database.
 * Tests built on it assert from bytes in to rows out, so a regression anywhere
 * in framing, parsing or persistence surfaces as a failing test.
 */
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';
import { ASTMHelperService } from '../services/astm-helper.service';
import { HL7HelperService } from '../services/hl7-helper.service';
import { InstrumentInterfaceService } from '../services/instrument-interface.service';
import { UtilitiesService } from '../services/utilities.service';

export const STX = '\x02';
export const ETX = '\x03';
export const EOT = '\x04';
export const ENQ = '\x05';
export const ACK = '\x06';
export const LF = '\x0A';
export const VT = '\x0B';
export const CR = '\x0D';
export const NAK = '\x15';
export const ETB = '\x17';
export const FS = '\x1C';

export type WireProtocol = 'hl7' | 'astm-checksum' | 'astm-nonchecksum';

export interface WireHarnessOptions {
  protocol: WireProtocol;
  machineType?: string;
  instrumentId?: string;
  labName?: string;
  host?: string;
  port?: number;
  /**
   * The instrument's saved result rules. Omitted, the instrument has no
   * saved rules and is read with the defaults for its protocol.
   */
  resultRules?: unknown;
}

export interface WireHarness {
  service: InstrumentInterfaceService;
  utilities: UtilitiesService;
  astmHelper: ASTMHelperService;
  hl7Helper: HL7HelperService;
  connection: any;
  dbService: any;
  /** Deliver bytes as one TCP chunk. */
  receive(bytes: string): void;
  /** Deliver bytes split into chunks of the given size. */
  receiveInChunks(bytes: string, chunkSize: number): void;
  /** Everything written back to the instrument, one entry per socket write. */
  sent(): string[];
  /** Results handed to the database, in order. */
  saved(): any[];
  /** Raw transmissions handed to the database, in order. */
  raw(): string[];
  /** Failure codes recorded as usage telemetry, in order. */
  failures(): string[];
  /** Make every subsequent result write fail. */
  failPersistence(): void;
  /** Simulate the instrument disconnecting. */
  disconnect(): void;
}

/**
 * E1381 checksum written independently of the implementation under test:
 * the modulo-256 sum of every byte after STX up to and including ETX or ETB,
 * as two uppercase hex digits.
 */
export function e1381Checksum(frameNumber: string, body: string, terminator: string): string {
  let sum = 0;
  for (const character of frameNumber + body + terminator) {
    sum = (sum + character.charCodeAt(0)) & 0xff;
  }
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

export interface FrameOptions {
  terminator?: 'ETX' | 'ETB';
  /** Override the checksum, e.g. to corrupt it. */
  checksum?: string;
  /** Bytes after the checksum. Defaults to CR LF. */
  lineEnd?: string;
}

/** Builds one E1381 frame: STX, frame number, body, ETX or ETB, checksum, CR LF. */
export function astmFrame(frameNumber: number | string, body: string, options: FrameOptions = {}): string {
  const terminator = options.terminator === 'ETB' ? ETB : ETX;
  const checksum = options.checksum ?? e1381Checksum(String(frameNumber), body, terminator);
  return STX + frameNumber + body + terminator + checksum + (options.lineEnd ?? CR + LF);
}

/**
 * Frames records the way an analyzer does: one record per frame, each ending
 * in CR, frame numbers running 1..7 then 0.
 */
export function astmFrames(records: string[], firstFrameNumber = 1): string[] {
  return records.map((record, index) => astmFrame((firstFrameNumber + index) % 8, record + CR));
}

/**
 * Splits one record across several frames using ETB continuation, with the
 * final piece terminated by ETX. Used for records longer than a frame allows.
 */
export function astmContinuationFrames(record: string, pieceLength: number, firstFrameNumber = 1): string[] {
  const text = record + CR;
  const pieces: string[] = [];
  for (let offset = 0; offset < text.length; offset += pieceLength) {
    pieces.push(text.slice(offset, offset + pieceLength));
  }
  return pieces.map((piece, index) => astmFrame(
    (firstFrameNumber + index) % 8,
    piece,
    { terminator: index === pieces.length - 1 ? 'ETX' : 'ETB' }
  ));
}

/** A complete E1381 session: ENQ, every frame, EOT. */
export function astmSession(frames: string[]): string {
  return ENQ + frames.join('') + EOT;
}

/** Wraps an HL7 message in an MLLP block. */
export function mllp(message: string, options: { vt?: boolean; cr?: boolean } = {}): string {
  return (options.vt === false ? '' : VT) + message + FS + (options.cr === false ? '' : CR);
}

/**
 * Builds an HL7 segment from a field-index map so a test never miscounts
 * pipes. Index 1 is the first field after the segment name.
 */
export function hl7Segment(name: string, fields: Record<number, string>): string {
  const highest = Math.max(0, ...Object.keys(fields).map(Number));
  const values: string[] = [];
  for (let index = 1; index <= highest; index++) {
    values.push(fields[index] ?? '');
  }
  return [name, ...values].join('|');
}

/** Builds an ASTM record from a field-index map. Index 1 is the sequence number. */
export function astmRecord(type: string, fields: Record<number, string>): string {
  return hl7Segment(type, fields);
}

/** Parses an HL7 message the tool wrote to the socket into segment field arrays. */
export function parseHL7Response(bytes: string): Record<string, string[]> {
  const stripped = bytes.replace(/[\x0b\x1c]/g, '').trim();
  const segments: Record<string, string[]> = {};
  for (const line of stripped.split(CR).filter(Boolean)) {
    const fields = line.split('|');
    segments[fields[0]] = fields;
  }
  return segments;
}

const IDENTICAL_FIELDS = [
  'order_id', 'instrument_id', 'test_id', 'test_type', 'results', 'results_as_sent', 'test_unit', 'notes', 'tested_by',
  'analysed_date_time', 'specimen_date_time', 'authorised_date_time', 'result_accepted_date_time', 'result_status'
];

function ensureWindowRequire(): void {
  // The HL7 ACK builder reaches crypto through Electron's window.require.
  const globalObject = globalThis as any;
  globalObject.window = globalObject.window ?? {};
  if (typeof globalObject.window.require !== 'function') {
    globalObject.window.require = (moduleName: string) => require(moduleName);
  }
}

export function createWireHarness(options: WireHarnessOptions): WireHarness {
  ensureWindowRequire();

  const instrumentId = options.instrumentId ?? 'ANALYZER-1';
  const host = options.host ?? '10.0.0.1';
  const port = options.port ?? 5001;
  const savedResults: any[] = [];
  const rawTransmissions: string[] = [];
  const telemetry: any[] = [];
  let persistenceFails = false;

  const dbService = {
    recordRawData: vi.fn((data: any, success: () => void) => {
      rawTransmissions.push(data.data);
      success();
    }),
    recordTestResults: vi.fn((data: any, success: (row: any) => void, failure: (error: any) => void) => {
      if (persistenceFails) {
        failure(new Error('database write failed'));
        return;
      }
      savedResults.push(data);
      success({ lastID: savedResults.length });
    }),
    recordTelemetryEvent: vi.fn(async (event: any) => {
      telemetry.push(event);
      return true;
    }),
    // The same comparison the database makes, over the results saved here.
    findIdenticalResult: vi.fn(async (record: any) => savedResults.some(saved =>
      IDENTICAL_FIELDS.every(field => (saved[field] ?? '') === (record[field] ?? ''))
    )),
    hasEarlierResult: vi.fn(async (record: any) => savedResults.some(saved =>
      saved.order_id === record.order_id && (saved.test_type ?? '') === (record.test_type ?? '')
    ))
  };
  const tcpService = {
    connectionStack: new Map<string, any>(),
    disconnect: vi.fn(),
    sendData: vi.fn()
  };
  const utilities = new UtilitiesService(null, null, { log: vi.fn() } as any);
  const astmHelper = new ASTMHelperService(utilities);
  const hl7Helper = new HL7HelperService(utilities);
  const store = {
    get: (key: string) => key === 'instrumentsConfig' && options.resultRules !== undefined
      ? [{ analyzerMachineName: instrumentId, interfaceCommunicationProtocol: options.protocol, resultRules: options.resultRules }]
      : undefined
  };
  const service = new InstrumentInterfaceService(
    dbService as any,
    tcpService as any,
    utilities,
    hl7Helper,
    astmHelper,
    store as any
  );

  const socket = { writable: true, write: vi.fn() };
  const connection = {
    connectionProtocol: options.protocol,
    connectionMode: 'tcpserver',
    instrumentId,
    machineType: options.machineType ?? 'generic',
    labName: options.labName ?? 'LAB001',
    host,
    port,
    connectionSocket: socket,
    statusSubject: new BehaviorSubject(false),
    connectionAttemptStatusSubject: new BehaviorSubject(false),
    transmissionStatusSubject: new BehaviorSubject(false),
    errorOccurred: false,
    reconnectAttempts: 0
  };
  const key = `${host}:${port}:tcpserver:${options.protocol}`;
  tcpService.connectionStack.set(key, connection);

  const receive = (bytes: string) => service.handleTCPResponse(key, Buffer.from(bytes, 'binary'));

  return {
    service,
    utilities,
    astmHelper,
    hl7Helper,
    connection,
    dbService,
    receive,
    receiveInChunks(bytes: string, chunkSize: number) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        receive(bytes.slice(offset, offset + chunkSize));
      }
    },
    sent: () => socket.write.mock.calls.map(call =>
      Buffer.isBuffer(call[0]) ? call[0].toString('binary') : String(call[0])
    ),
    saved: () => savedResults,
    raw: () => rawTransmissions,
    failures: () => telemetry.map(event => event.failureCode),
    failPersistence: () => { persistenceFails = true; },
    disconnect: () => service.disconnect({ connectionParams: { instrumentId, host, port } })
  };
}
