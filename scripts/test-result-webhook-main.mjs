// Exercises the result webhook's main-process handlers against a real SQLite
// database, with Electron replaced by a stand-in.
//
// The save handler decides which stored results a receiver never gets. That
// decision has to come from what is stored, not from what a form believed, so
// it is checked against the real module rather than a copy of its logic. The
// module is compiled on the fly because the app's TypeScript is not built at
// test time.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'result-webhook-main-'));

function compileModule() {
  const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  execFileSync(tsc, [
    path.join(repoRoot, 'app', 'result-webhook.main.ts'),
    '--rootDir', repoRoot,
    '--outDir', outDir,
    '--module', 'node16',
    '--target', 'es2022',
    '--moduleResolution', 'node16',
    '--strict', 'false',
    '--types', 'node',
    '--typeRoots', path.join(repoRoot, 'node_modules', '@types'),
    '--skipLibCheck'
  ], { stdio: 'pipe', cwd: outDir });
  return path.join(outDir, 'app', 'result-webhook.main.js');
}

// --- Electron stand-in -----------------------------------------------------

const handlers = new Map();
const requests = [];
let nextStatus = 200;
const electron = {
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: buffer => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('undecryptable');
      return text.slice('sealed:'.length);
    }
  },
  net: {
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { status: nextStatus, body: null };
    }
  }
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electron;
  return originalLoad.call(this, request, ...rest);
};

function createStore() {
  const data = new Map();
  return {
    get: key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    set: (key, value) => data.set(key, structuredClone(value)),
    raw: data
  };
}

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    result_webhook_status INTEGER NOT NULL DEFAULT 0
  )`);
  return {
    database,
    insert: orderId => database.prepare('INSERT INTO orders (order_id) VALUES (?)').run(orderId),
    statuses: () => database.prepare('SELECT order_id, result_webhook_status AS status FROM orders ORDER BY id').all()
      .map(row => ({ ...row })),
    // The shape of @vscode/sqlite3's Database.run, which is all the module uses.
    adapter: {
      run(sql, params, callback) {
        try {
          database.prepare(sql).run(...params);
          callback(null);
        } catch (error) {
          callback(error);
        }
      }
    }
  };
}

const { registerResultWebhookIpc } = createRequire(import.meta.url)(compileModule());

async function withHandlers(fn) {
  handlers.clear();
  requests.length = 0;
  nextStatus = 200;
  const store = createStore();
  const db = createDatabase();
  let databaseOpen = true;
  registerResultWebhookIpc(store, () => (databaseOpen ? db.adapter : null));
  const invoke = (channel, payload) => handlers.get(channel)({}, payload);
  try {
    await fn({ store, db, invoke, closeDatabase: () => { databaseOpen = false; } });
  } finally {
    db.database.close();
  }
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const receiver = 'https://engine.example.org/results';

try {
  await check('the first save marks stored results not queued, even with forwarding off', () => withHandlers(async ({ db, invoke }) => {
    db.insert('BEFORE-1');
    const saved = await invoke('result-webhook-save', { enabled: false, url: receiver, authType: 'none' });
    assert.equal(saved.ok, true);
    assert.ok(saved.data.activatedAt);
    db.insert('WHILE-OFF-1');

    // Turning it on later must not touch results kept while it was off.
    const enabled = await invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'none' });
    assert.equal(enabled.ok, true);
    assert.deepEqual(db.statuses(), [
      { order_id: 'BEFORE-1', status: 2 },
      { order_id: 'WHILE-OFF-1', status: 0 }
    ]);
  }));

  await check('a save that fails validation changes nothing', () => withHandlers(async ({ store, db, invoke }) => {
    db.insert('BEFORE-1');
    const failed = await invoke('result-webhook-save', { enabled: true, url: 'not a url', authType: 'none' });
    assert.equal(failed.ok, false);
    assert.equal(store.get('resultWebhook'), undefined);
    assert.deepEqual(db.statuses(), [{ order_id: 'BEFORE-1', status: 0 }]);
  }));

  await check('a save with the database closed records no activation', () => withHandlers(async ({ store, db, invoke, closeDatabase }) => {
    db.insert('BEFORE-1');
    closeDatabase();
    const failed = await invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'none' });
    assert.equal(failed.error.code, 'database_unavailable');
    assert.equal(store.get('resultWebhook'), undefined);
  }));

  await check('concurrent first saves mark history once', () => withHandlers(async ({ db, invoke }) => {
    db.insert('BEFORE-1');
    const first = invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'none' });
    const second = invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'none' });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.data.activatedAt, b.data.activatedAt);
  }));

  await check('the secret is sealed at rest and never returned to the renderer', () => withHandlers(async ({ store, invoke }) => {
    const saved = await invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'bearer', secret: 'tok3n' });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.hasSecret, true);
    assert.ok(!JSON.stringify(saved).includes('tok3n'));
    assert.ok(!JSON.stringify(store.get('resultWebhook')).includes('tok3n'));
    const loaded = await invoke('result-webhook-get');
    assert.ok(!JSON.stringify(loaded).includes('sealed'));
  }));

  await check('Send test never carries the saved secret to another origin', () => withHandlers(async ({ invoke }) => {
    await invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'bearer', secret: 'tok3n' });
    const result = await invoke('result-webhook-test', { enabled: true, url: 'https://elsewhere.example.net/', authType: 'bearer' });
    assert.equal(result.ok, false);
    assert.equal(requests.length, 0);

    const sameOrigin = await invoke('result-webhook-test', { enabled: true, url: `${receiver}/check`, authType: 'bearer' });
    assert.equal(sameOrigin.ok, true);
    assert.equal(requests[0].headers.Authorization, 'Bearer tok3n');
    assert.equal(requests[0].body.test, true);
    assert.deepEqual(requests[0].body.results, []);
  }));

  await check('forwarding can be turned off when the saved secret no longer decrypts', () => withHandlers(async ({ store, invoke }) => {
    await invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'bearer', secret: 'tok3n' });
    store.set('resultWebhook', { ...store.get('resultWebhook'), encryptedSecret: Buffer.from('garbage').toString('base64') });
    const off = await invoke('result-webhook-save', { enabled: false, url: receiver, authType: 'bearer' });
    assert.equal(off.ok, true);
    assert.equal(off.data.enabled, false);
  }));

  await check('a delivery succeeds only on 2xx and records health against its receiver', () => withHandlers(async ({ store, invoke }) => {
    await invoke('result-webhook-save', { enabled: true, url: receiver, authType: 'none' });
    const row = {
      id: 1, ingestion_id: 'ingest-1', instrument_id: null, machine_used: 'A', order_id: 'S-1', test_id: null,
      test_type: 'VL', test_description: null, test_location: null, results: '<20', test_unit: 'cp/mL',
      result_status: 1, notes: null, tested_by: null, repeated: 0, analysed_date_time: null,
      specimen_date_time: null, authorised_date_time: null, result_accepted_date_time: null, added_on: null, raw_text: null
    };

    nextStatus = 503;
    const refused = await invoke('result-webhook-submit', { results: [row] });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.httpStatus, 503);
    assert.equal(store.get('resultWebhook').health, 'attention');

    nextStatus = 202;
    const accepted = await invoke('result-webhook-submit', { results: [row] });
    assert.equal(accepted.ok, true);
    assert.equal(requests.at(-1).body.results[0].results, '<20');
    assert.equal(store.get('resultWebhook').health, 'delivering');
    assert.equal(store.get('resultWebhook').lastError, undefined);
  }));

  await check('nothing is sent while forwarding is off', () => withHandlers(async ({ invoke }) => {
    await invoke('result-webhook-save', { enabled: false, url: receiver, authType: 'none' });
    const result = await invoke('result-webhook-submit', { results: [{ id: 1, ingestion_id: 'x', order_id: 'S' }] });
    assert.equal(result.error.code, 'not_enabled');
    assert.equal(requests.length, 0);
  }));

  console.log(`Result webhook main-process tests passed (${passed}).`);
} finally {
  Module._load = originalLoad;
  fs.rmSync(outDir, { recursive: true, force: true });
}
