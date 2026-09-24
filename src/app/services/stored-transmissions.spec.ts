/**
 * Each transmission is stored once, in raw_data, and every result read from
 * it carries its identifier and only the records it was read from. These
 * tests run the real services against a real SQLite database built from the
 * application's own migrations, so what they check is the stored rows.
 */
import { describe, expect, it, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { DatabaseService } from './database.service';
import { InstrumentInterfaceService } from './instrument-interface.service';
import { RawDataProcessorService } from './raw-data-processor.service';
import { UtilitiesService } from './utilities.service';
import { ASTMHelperService } from './astm-helper.service';
import { HL7HelperService } from './hl7-helper.service';
import { mllp } from '../testing/wire-harness';
import { M2000_RUN_SAMPLES, m2000Session } from '../testing/fixtures/captured/abbott-m2000';
import { COBAS_4800_RUN, cobas4800Run } from '../testing/fixtures/captured/roche-cobas-4800';

// Loaded when the tests run: the test bundler cannot bundle node:sqlite.
const nodeRequire = (name: string) => require(name);
const { readdirSync, readFileSync } = nodeRequire('node:fs');
const { join } = nodeRequire('node:path');
const { createHash } = nodeRequire('node:crypto');
const { DatabaseSync } = nodeRequire('node:sqlite');
type DatabaseSync = any;

const MIGRATIONS = join(process.cwd(), 'app', 'sqlite-migrations');

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((name: string) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return database;
}

interface Setup {
  database: DatabaseSync;
  dbService: any;
  service: InstrumentInterfaceService;
  processor: RawDataProcessorService;
  connection: any;
  receive(bytes: string): Promise<void>;
  rows(sql: string, params?: any[]): any[];
  setInstrument(changes: Record<string, unknown>): void;
}

function setup(protocol: 'hl7' | 'astm-checksum', machineType: string): Setup {
  const globalObject = globalThis as any;
  globalObject.window = globalObject.window ?? {};
  if (typeof globalObject.window.require !== 'function') {
    globalObject.window.require = (moduleName: string) => require(moduleName);
  }

  const database = migratedDatabase();
  const rows = (sql: string, params: any[] = []) => database.prepare(sql).all(...params).map((row: any) => ({ ...row }));
  const instrument: any = {
    analyzerMachineName: 'ANALYZER-1',
    analyzerMachineType: machineType,
    interfaceCommunicationProtocol: protocol,
    labName: 'LAB001'
  };
  const store = {
    get: (key: string) => key === 'instrumentsConfig' ? [instrument] : undefined,
    set: vi.fn()
  };

  // The real service without its constructor, which would start the
  // application's configuration subscriptions and MySQL.
  const dbService = Object.create(DatabaseService.prototype) as any;
  dbService.store = store;
  dbService.mysqlPool = null;
  dbService.commonSettings = {};
  dbService.resultRecordedSubject = { next: vi.fn() };
  dbService.usageRecordedSubject = { next: vi.fn() };
  dbService.checkMysqlConnection = (_params: unknown, _success: unknown, failure: (error: Error) => void) => failure(new Error('no MySQL'));
  dbService.recordTelemetryEvent = vi.fn().mockResolvedValue(true);
  dbService.execSqlite = async (sql: string, params: any[] = []) => {
    const statement = database.prepare(sql);
    if (/^\s*(select|pragma|with)\b/i.test(sql)) {
      return statement.all(...(params ?? [])).map((row: any) => ({ ...row }));
    }
    const result = statement.run(...(params ?? []));
    return { changes: Number(result.changes), lastID: Number(result.lastInsertRowid) };
  };

  const utilities = new UtilitiesService(null, null, { log: vi.fn() } as any);
  const service = new InstrumentInterfaceService(
    dbService,
    { connectionStack: new Map(), sendData: vi.fn(), disconnect: vi.fn() } as any,
    utilities,
    new HL7HelperService(utilities),
    new ASTMHelperService(utilities),
    store as any
  );
  const processor = new RawDataProcessorService(utilities, store as any, service);

  const connection = {
    connectionProtocol: protocol,
    connectionMode: 'tcpserver',
    instrumentId: 'ANALYZER-1',
    machineType,
    labName: 'LAB001',
    connectionSocket: { writable: true, write: vi.fn() },
    statusSubject: new BehaviorSubject(false),
    connectionAttemptStatusSubject: new BehaviorSubject(false),
    transmissionStatusSubject: new BehaviorSubject(false),
    errorOccurred: false,
    reconnectAttempts: 0
  };
  (service as any).tcpService.connectionStack.set('key', connection);

  return {
    database,
    dbService,
    service,
    processor,
    connection,
    rows,
    setInstrument: changes => Object.assign(instrument, changes),
    async receive(bytes: string) {
      service.handleTCPResponse('key', Buffer.from(bytes, 'binary'));
      // Let the writes, which go through promises, land.
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  };
}

const COBAS_4800_MESSAGE = cobas4800Run('MSG-4800-RUN', COBAS_4800_RUN);

describe('a transmission received live', () => {
  it('is stored once with an identifier and fingerprint that each of its results carries', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    await s.receive(mllp(COBAS_4800_MESSAGE));

    const [transmission] = s.rows('SELECT * FROM raw_data');
    expect(transmission.transmission_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(transmission.sha256).toBe(createHash('sha256').update(transmission.data, 'utf8').digest('hex'));

    const results = s.rows('SELECT order_id, transmission_id, raw_text FROM orders ORDER BY id');
    expect(results).toHaveLength(COBAS_4800_RUN.length);
    expect(new Set(results.map(result => result.transmission_id))).toEqual(new Set([transmission.transmission_id]));
  });

  it('gives each result of a batch only the segments it was read from', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    await s.receive(mllp(COBAS_4800_MESSAGE));

    for (const result of s.rows('SELECT order_id, raw_text FROM orders')) {
      const others = COBAS_4800_RUN.map(sample => sample.sampleId).filter(id => id !== result.order_id);
      expect(result.raw_text).toMatch(/^MSH\|/);
      expect(result.raw_text).toContain(result.order_id);
      for (const other of others) {
        expect(result.raw_text).not.toContain(other);
      }
      expect(result.raw_text.length).toBeLessThan(COBAS_4800_MESSAGE.length / 2);
    }
  });

  it('gives each ASTM result the records of its own order', async () => {
    const s = setup('astm-checksum', 'abbott-m2000');
    await s.receive(m2000Session(M2000_RUN_SAMPLES));

    const results = s.rows('SELECT order_id, raw_text FROM orders');
    expect(results).toHaveLength(M2000_RUN_SAMPLES.length);
    for (const result of results) {
      const orderRecords = result.raw_text.split('<CR>').filter((record: string) => /^\d*O\|/.test(record));
      expect(orderRecords).toHaveLength(1);
      expect(orderRecords[0]).toContain(result.order_id);
      expect(result.raw_text).toMatch(/^\d*H\|/);
    }
  });
});

describe('the records a result keeps', () => {
  it('gives each order of a two-patient ASTM batch its own patient record, not the next one\'s', () => {
    const utilities = new UtilitiesService(null, null, { log: vi.fn() } as any);
    const astm = new ASTMHelperService(utilities);
    const records = [
      'H|\\^&|||ANALYZER^1.0|||||||P|1|20260101120000',
      'P|1|||PATIENT-ONE',
      'O|1|S1||^^^HIV|R|20260101110000|||||||||||||||||||F',
      'R|1|^^^HIV|120|cp/mL||||F||op||20260101115000',
      'P|2|||PATIENT-TWO',
      'C|1||patient two comment',
      'O|1|S2||^^^HIV|R|20260101110000|||||||||||||||||||F',
      'R|1|^^^HIV|<40|cp/mL||||F||op||20260101115000',
      'L|1|N'
    ];

    const [first, second] = astm.extractASTMResults(records, records.join('<CR>')).results;

    expect(first.raw_text.split('<CR>')).toEqual([records[0], records[1], records[2], records[3]]);
    expect(second.raw_text.split('<CR>')).toEqual([records[0], records[4], records[5], records[6], records[7]]);
  });
});

describe('reading an HL7 message', () => {
  it('keeps the other specimens when one cannot be read', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    const hl7Helper = (s.service as any).hl7Helper;
    const extract = hl7Helper.extractHL7OrderAndTestIDs.bind(hl7Helper);
    let calls = 0;
    vi.spyOn(hl7Helper, 'extractHL7OrderAndTestIDs').mockImplementation((...args: any[]) => {
      if (++calls === 2) {
        throw new Error('unreadable specimen');
      }
      return extract(...args);
    });

    await s.receive(mllp(COBAS_4800_MESSAGE));

    expect(s.rows('SELECT order_id FROM orders')).toHaveLength(COBAS_4800_RUN.length - 1);
  });

  it('reports a reprocessed transmission as failed when one specimen cannot be read', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    const hl7Helper = (s.service as any).hl7Helper;
    const extract = hl7Helper.extractHL7OrderAndTestIDs.bind(hl7Helper);
    const unreadableSample = COBAS_4800_RUN[1].sampleId;
    vi.spyOn(hl7Helper, 'extractHL7OrderAndTestIDs').mockImplementation((...args: any[]) => {
      const ids = extract(...args);
      if (ids.order_id === unreadableSample) {
        throw new Error('unreadable specimen');
      }
      return ids;
    });
    await s.receive(mllp(COBAS_4800_MESSAGE));

    const status = await s.processor.reprocessMatching('sqlite', {});

    expect(status).toMatchObject({ success: 0, failed: 1, unchanged: COBAS_4800_RUN.length - 1 });
  });
});

describe('reprocessing', () => {
  it('stores nothing again when every result is already stored as read', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    await s.receive(mllp(COBAS_4800_MESSAGE));
    const before = s.rows('SELECT id FROM orders').length;

    const status = await s.processor.reprocessMatching('sqlite', {});

    expect(status).toMatchObject({ success: 1, failed: 0, saved: 0, unchanged: before });
    expect(s.rows('SELECT id FROM orders')).toHaveLength(before);
  });

  it('stores a result that now reads differently as a repeat linked to the same transmission', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    await s.receive(mllp(COBAS_4800_MESSAGE));
    const [transmission] = s.rows('SELECT transmission_id FROM raw_data');

    s.setInstrument({ resultRules: [{ match: 'exact', value: 'Invalid', replaceWith: 'Invalid run' }] });
    const status = await s.processor.reprocessMatching('sqlite', {});

    expect(status).toMatchObject({ saved: 1, unchanged: COBAS_4800_RUN.length - 1 });
    const repeat = s.rows('SELECT * FROM orders WHERE repeated = 1');
    expect(repeat).toHaveLength(1);
    expect(repeat[0]).toMatchObject({ order_id: 'VL260004', results: 'Invalid run', transmission_id: transmission.transmission_id });
  });

  it('counts an analyzer\'s order query as holding no results, not as a failure', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    const query = [
      'MSH|^~\\&|cobas 4800 software 2.2.0.1509|""|LIS|LIS Facility|20250415151356+0200||QBP^Q11^QBP_Q11|Q-1|P|2.5.1|||ER|AL||UNICODE UTF-8|||LAB-27^IHE',
      'QPD|WOS^Work Order Step^IHELAW|Q-1-1|VL0001',
      'RCP|I||R'
    ].join('\r');
    await s.receive(mllp(query));
    await s.receive(mllp(COBAS_4800_MESSAGE));

    const status = await s.processor.reprocessMatching('sqlite', {});

    expect(status).toMatchObject({ processedCount: 2, success: 1, empty: 1, failed: 0 });
  });

  it('counts an ASTM session with no order record as holding no results', async () => {
    const s = setup('astm-checksum', 'abbott-m2000');
    s.database.prepare('INSERT INTO raw_data (data, machine, instrument_id) VALUES (?, ?, ?)')
      .run('\x021H|\\^&|||m2000\rQ|1|ALL||^^^\rL|1|N\r\x0333\r\n', 'ANALYZER-1', 'ANALYZER-1');

    const status = await s.processor.reprocessMatching('sqlite', {});

    expect(status).toMatchObject({ processedCount: 1, empty: 1, failed: 0 });
  });

  it('counts ASTM reprocessed under an HL7 setting as a failure, not as holding no results', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    s.database.prepare('INSERT INTO raw_data (data, machine, instrument_id) VALUES (?, ?, ?)')
      .run('\x021H|\\^&|||ANALYZER\rP|1\rO|1|VL0001||^^^HIV\rR|1|^^^HIV|1250|cp/mL\rL|1|N\r\x0333\r\n', 'ANALYZER-1', 'ANALYZER-1');

    const status = await s.processor.reprocessMatching('sqlite', {});

    expect(status).toMatchObject({ processedCount: 1, empty: 0, failed: 1 });
  });

  it('counts an ASTM session with results but no readable order as a failure', async () => {
    const s = setup('astm-checksum', 'abbott-m2000');
    s.database.prepare('INSERT INTO raw_data (data, machine, instrument_id) VALUES (?, ?, ?)')
      .run('\x021H|\\^&|||m2000\rP|1\rR|1|^^^HIV|1250|cp/mL\rL|1|N\r\x0333\r\n', 'ANALYZER-1', 'ANALYZER-1');

    const status = await s.processor.reprocessMatching('sqlite', {});

    expect(status).toMatchObject({ processedCount: 1, empty: 0, failed: 1 });
  });

  it('reprocesses only the transmissions the filter matches, a batch at a time', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    for (let i = 0; i < 25; i++) {
      await s.receive(mllp(cobas4800Run(`MSG-${i}`, [{ sampleId: `VL-${i}`, value: 'Target Not Detected' }])));
    }
    s.database.exec("UPDATE raw_data SET added_on = '2026-01-10 10:00:00' WHERE id <= 5");
    s.database.exec("UPDATE raw_data SET added_on = '2026-01-11 23:59:59' WHERE id BETWEEN 6 AND 7");
    s.database.exec("UPDATE raw_data SET added_on = '2026-01-12 00:00:00' WHERE id > 7");

    const status = await s.processor.reprocessMatching('sqlite', { instrumentId: 'ANALYZER-1', from: '2026-01-10', to: '2026-01-11' });

    expect(status).toMatchObject({ totalCount: 7, processedCount: 7, success: 7, unchanged: 7, saved: 0 });
  });

  it('stops when asked and reports how far it got', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    for (let i = 0; i < 30; i++) {
      await s.receive(mllp(cobas4800Run(`MSG-${i}`, [{ sampleId: `VL-${i}`, value: 'Target Not Detected' }])));
    }
    const subscription = s.processor.getReprocessingStatus().subscribe(status => {
      if (status.processedCount === 3) {
        s.processor.cancel();
      }
    });

    const status = await s.processor.reprocessMatching('sqlite', {});
    subscription.unsubscribe();

    expect(status.cancelled).toBe(true);
    expect(status.processedCount).toBe(3);
    expect(status.totalCount).toBe(30);
  });
});

describe('compacting storage', () => {
  /** Stores a transmission and results the way builds before identifiers did. */
  function storeAsOldBuild(s: Setup, message: string, receivedAt: string, resultStoredAt: string) {
    s.database.prepare('INSERT INTO raw_data (data, machine, instrument_id, added_on) VALUES (?, ?, ?, ?)')
      .run(mllp(message), 'ANALYZER-1', 'ANALYZER-1', receivedAt);
    const insert = s.database.prepare(`INSERT INTO orders
      (order_id, test_id, test_type, results, results_as_sent, raw_text, added_on, lims_sync_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);
    for (const result of s.service.readHL7Results(s.connection, message, false)) {
      // Older builds kept the whole message on every result.
      insert.run(result.order_id, result.test_id, result.test_type, result.results, result.results, message, resultStoredAt);
    }
  }

  it('links each result to its transmission and keeps only its own segments', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    storeAsOldBuild(s, COBAS_4800_MESSAGE, '2025-08-17 04:00:00', '2025-08-17 04:00:02');
    const expected = s.service.readHL7Results(s.connection, COBAS_4800_MESSAGE, false);

    const report = await s.processor.compactStorage('sqlite');

    const [transmission] = s.rows('SELECT * FROM raw_data');
    expect(transmission.transmission_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(transmission.data).toBe(mllp(COBAS_4800_MESSAGE));
    expect(transmission.sha256).toBe(createHash('sha256').update(transmission.data, 'utf8').digest('hex'));
    expect(report).toMatchObject({ transmissions: 1, linkedResults: COBAS_4800_RUN.length, trimmedResults: COBAS_4800_RUN.length });
    for (const row of s.rows('SELECT order_id, transmission_id, raw_text FROM orders')) {
      expect(row.transmission_id).toBe(transmission.transmission_id);
      expect(row.raw_text).toBe(expected.find(result => result.order_id === row.order_id).raw_text);
    }
  });

  it('links but keeps whole a result when the sample ran twice alike in the transmission', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    const twice = cobas4800Run('MSG-TWICE', [
      { sampleId: 'VL260001', value: 'Target Not Detected' },
      { sampleId: 'VL260001', value: 'Target Not Detected' },
      { sampleId: 'VL260002', value: '< Titer min' }
    ]);
    s.database.prepare('INSERT INTO raw_data (data, machine, instrument_id, added_on) VALUES (?, ?, ?, ?)')
      .run(mllp(twice), 'ANALYZER-1', 'ANALYZER-1', '2025-08-17 04:00:00');
    const insert = s.database.prepare(`INSERT INTO orders
      (order_id, test_id, test_type, results, results_as_sent, raw_text, added_on, lims_sync_status)
      VALUES (?, ?, ?, ?, ?, ?, '2025-08-17 04:00:02', 1)`);
    for (const result of s.service.readHL7Results(s.connection, twice, false)) {
      insert.run(result.order_id, result.test_id, result.test_type, result.results, result.results, twice);
    }

    const report = await s.processor.compactStorage('sqlite');

    expect(report).toMatchObject({ linkedResults: 3, trimmedResults: 1 });
    for (const row of s.rows("SELECT raw_text, transmission_id FROM orders WHERE order_id = 'VL260001'")) {
      expect(row.transmission_id).not.toBeNull();
      expect(row.raw_text).toBe(twice);
    }
  });

  it('leaves whole a result whose transmission is not stored', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    storeAsOldBuild(s, COBAS_4800_MESSAGE, '2025-08-17 04:00:00', '2025-08-17 04:00:02');
    // The same sample in a message whose transmission was never stored.
    const lost = COBAS_4800_MESSAGE.replace('MSG-4800-RUN', 'MSG-NOT-STORED');
    s.database.prepare(`INSERT INTO orders (order_id, test_type, results, raw_text, added_on, lims_sync_status)
      VALUES ('VL260001', 'HIV', 'Target Not Detected', ?, '2025-08-18 09:00:00', 1)`).run(lost);

    await s.processor.compactStorage('sqlite');

    const [kept] = s.rows("SELECT transmission_id, raw_text FROM orders WHERE raw_text LIKE '%MSG-NOT-STORED%'");
    expect(kept).toEqual({ transmission_id: null, raw_text: lost });
  });

  it('does not link a result stored well before the transmission arrived', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    // The analyzer sent the same message again an hour later; only the
    // results of the second sending are that transmission's.
    storeAsOldBuild(s, COBAS_4800_MESSAGE, '2025-08-17 05:00:00', '2025-08-17 04:00:02');

    const report = await s.processor.compactStorage('sqlite');

    expect(report.linkedResults).toBe(0);
    expect(s.rows('SELECT id FROM orders WHERE transmission_id IS NULL')).toHaveLength(COBAS_4800_RUN.length);
  });

  it('never changes a stored transmission', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    storeAsOldBuild(s, COBAS_4800_MESSAGE, '2025-08-17 04:00:00', '2025-08-17 04:00:02');
    const [before] = s.rows('SELECT data, added_on, instrument_id, machine FROM raw_data');

    await s.processor.compactStorage('sqlite');

    expect(s.rows('SELECT data, added_on, instrument_id, machine FROM raw_data')).toEqual([before]);
  });
});

describe('comparing a result with its transmission', () => {
  it('reads the records under any framing an older build stored', () => {
    const records = 'H|@^\\|GXM-1\nP|1\nO|1|724\nR|1|^UV2^^TBPos^Xpert MTB-RIF Ultra^4^MTB^|NOT DETECTED^';
    // As stored by older builds: frame digit kept, <CR> markers, the checksum as a line.
    const stored = '1H|@^\\|GXM-1<CR>P|1<CR>O|1|724<CR>R|1|^UV2^^TBPos^Xpert MTB-RIF Ultra^4^MTB^|NOT DETECTED^<CR>35';
    // As it arrived: start marker, frames, a record cut across two frames.
    const arrived = '##START##\x021H|@^\\|GXM-1\rP|1\rO|1|724\rR|1|^UV2^^TBPos^\x17A6\r\n\x022Xpert MTB-RIF Ultra^4^MTB^|NOT DETECTED^\r\x0335\r\n';
    const utilities = new UtilitiesService(null, null, { log: vi.fn() } as any);

    expect(RawDataProcessorService.recordsOf(stored)).toBe(records);
    expect(RawDataProcessorService.recordsOf(utilities.removeControlCharacters(arrived, true))).toBe(records);
  });

  it('keeps a value that only looks like framing inside a record', () => {
    expect(RawDataProcessorService.recordsOf('R|1|^^^HIV|35|cp/mL')).toBe('R|1|^^^HIV|35|cp/mL');
  });

  it('links ASTM results whose records keep their frame numbers', async () => {
    const s = setup('astm-checksum', 'abbott-m2000');
    await s.receive(m2000Session(M2000_RUN_SAMPLES));
    // The records kept on these results carry their frame numbers ("1H|"),
    // which the transmission, read the way the parser reads it, does not.
    expect(s.rows('SELECT raw_text FROM orders')[0].raw_text).toMatch(/^1H\|/);
    s.database.exec('UPDATE raw_data SET transmission_id = NULL, sha256 = NULL');
    s.database.exec('UPDATE orders SET transmission_id = NULL');

    const report = await s.processor.compactStorage('sqlite');

    expect(report.linkedResults).toBe(M2000_RUN_SAMPLES.length);
    expect(s.rows('SELECT id FROM orders WHERE transmission_id IS NULL')).toHaveLength(0);
  });
});

describe('finding a stored result', () => {
  it('never takes a sample ID that differs only in case for the same sample', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    // As MySQL's usual collation would answer "ab12" for "AB12".
    s.dbService.execSqlite = vi.fn().mockResolvedValue([{ order_id: 'ab12' }]);

    expect(await s.dbService.findIdenticalResult({ order_id: 'AB12', result_status: 1 })).toBe(false);
    expect(await s.dbService.hasEarlierResult({ order_id: 'AB12' })).toBe(false);
  });
});

describe('listing raw data', () => {
  it('filters with parameters, so search text is never read as SQL', async () => {
    const s = setup('hl7', 'roche-cobas-4800');
    await s.receive(mllp(COBAS_4800_MESSAGE));

    expect((await s.dbService.listRawData({ search: "' OR 1=1 --" }, 50, 0)).total).toBe(0);
    expect((await s.dbService.listRawData({ search: '100%' }, 50, 0)).total).toBe(0);
    expect((await s.dbService.listRawData({ search: 'VL260003' }, 50, 0)).total).toBe(1);
    expect((await s.dbService.listRawData({ instrumentId: 'OTHER' }, 50, 0)).total).toBe(0);
  });
});
