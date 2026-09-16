import { ipcMain, net, safeStorage } from 'electron';
import { randomUUID } from 'crypto';
import type * as sqlite3 from '@vscode/sqlite3';
import {
  buildResultWebhookPayload,
  isValidResultWebhookBatch,
  RESULT_WEBHOOK_STATUS,
  ResolvedResultWebhookTarget,
  resolveResultWebhookTarget,
  ResultWebhookError,
  ResultWebhookIpcResult,
  ResultWebhookResult,
  ResultWebhookSaveRequest,
  ResultWebhookSource,
  ResultWebhookState,
  ResultWebhookValidationError,
  StoredResultWebhook
} from '../shared/result-webhook';

interface StoreLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface ResultWebhookDelivery {
  httpStatus: number;
  delivered: number;
}

class ResultWebhookRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus?: number
  ) {
    super(message);
  }
}

// Not exported through settings backups: the secret is sealed to this
// machine's keychain. See INSTALLATION_IDENTITY_KEYS.
export const RESULT_WEBHOOK_KEY = 'resultWebhook';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function getStored(store: StoreLike): StoredResultWebhook | null {
  const value = store.get(RESULT_WEBHOOK_KEY);
  if (!value || typeof value !== 'object') return null;
  return value as StoredResultWebhook;
}

function publicState(stored: StoredResultWebhook | null): ResultWebhookState {
  if (!stored) {
    return { configured: false, enabled: false, url: '', authType: 'none', username: '', hasSecret: false };
  }
  const { encryptedSecret, schemaVersion: _schemaVersion, ...state } = stored;
  return { ...state, configured: true, hasSecret: !!encryptedSecret };
}

function encryptSecret(secret: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new ResultWebhookRequestError(
      'secure_storage_unavailable',
      'Secure credential storage is unavailable on this computer, so a receiver secret cannot be saved.'
    );
  }
  return safeStorage.encryptString(secret).toString('base64');
}

function decryptSecret(encryptedSecret: string): string {
  try {
    return safeStorage.decryptString(Buffer.from(encryptedSecret, 'base64'));
  } catch {
    throw new ResultWebhookRequestError(
      'credential_unavailable',
      'The saved receiver secret cannot be read on this computer. Enter it again in Settings.'
    );
  }
}

function resolveTarget(request: Partial<ResultWebhookSaveRequest>, stored: StoredResultWebhook | null): ResolvedResultWebhookTarget {
  try {
    return resolveResultWebhookTarget(request, stored);
  } catch (error) {
    if (error instanceof ResultWebhookValidationError) {
      throw new ResultWebhookRequestError(error.code, error.message);
    }
    throw error;
  }
}

/** Reads the secret only at the moment a request needs it. */
function secretFor(target: ResolvedResultWebhookTarget, stored: StoredResultWebhook | null): string {
  switch (target.secret.kind) {
    case 'provided':
      return target.secret.secret;
    case 'stored':
      return decryptSecret(stored.encryptedSecret);
    default:
      return '';
  }
}

function authorizationHeaders(target: ResolvedResultWebhookTarget, secret: string): Record<string, string> {
  switch (target.authType) {
    case 'bearer':
      return { Authorization: `Bearer ${secret}` };
    case 'basic':
      return { Authorization: `Basic ${Buffer.from(`${target.username}:${secret}`, 'utf8').toString('base64')}` };
    case 'apikey':
      return { 'X-API-Key': secret };
    default:
      return {};
  }
}

function sourceFor(store: StoreLike): ResultWebhookSource {
  const common = (store.get('commonConfig') || {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return {
    application: 'intelis-interfacing',
    appVersion: text(store.get('appVersion')),
    installationId: text(store.get('sourceInstallationId')),
    labId: text(common['labID']),
    labName: text(common['labName'])
  };
}

async function discardBody(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return;
    }
  }
}

/**
 * Any 2xx is delivery of the whole batch; anything else is not. The body is
 * never interpreted, so a receiver does not have to speak any response format.
 */
async function post(url: string, headers: Record<string, string>, body: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await net.fetch(url, {
      method: 'POST',
      body,
      signal: controller.signal,
      // A redirect would resend results, and credentials, somewhere nobody configured.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json, text/plain, */*',
        'Cache-Control': 'no-store',
        ...headers
      }
    });
    await discardBody(response).catch(() => undefined);
    if (response.status < 200 || response.status > 299) {
      throw new ResultWebhookRequestError(
        `http_${response.status}`,
        `The receiver answered HTTP ${response.status}.`,
        response.status
      );
    }
    return response.status;
  } catch (error) {
    if (error instanceof ResultWebhookRequestError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new ResultWebhookRequestError('request_timeout', 'The receiver did not answer within 30 seconds.');
    }
    throw new ResultWebhookRequestError(
      'connection_failed',
      'Unable to reach the receiver, or it answered with a redirect, which is not followed.'
    );
  } finally {
    clearTimeout(timeout);
  }
}

function errorResult(error: unknown): ResultWebhookIpcResult<never> {
  const normalized = error instanceof ResultWebhookRequestError
    ? error
    : new ResultWebhookRequestError('unexpected_error', 'The result webhook request could not be completed.');
  const failure: ResultWebhookError = { code: normalized.code, message: normalized.message };
  if (normalized.httpStatus !== undefined) failure.httpStatus = normalized.httpStatus;
  return { ok: false, error: failure };
}

function runSql(db: sqlite3.Database, sql: string, params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

/**
 * Re-reads the store after the request: settings saved while it was in flight
 * win, and health is only recorded against the receiver it describes.
 */
function recordHealth(
  store: StoreLike,
  url: string,
  update: Pick<StoredResultWebhook, 'health' | 'lastCheckedAt'> & Partial<Pick<StoredResultWebhook, 'lastDeliveredAt' | 'lastError'>>
): void {
  const current = getStored(store);
  if (!current || current.url !== url) return;
  const next: StoredResultWebhook = { ...current, ...update };
  if (!update.lastError) delete next.lastError;
  store.set(RESULT_WEBHOOK_KEY, next);
}

export function registerResultWebhookIpc(store: StoreLike, getDatabase: () => sqlite3.Database | null): void {
  // Saves run one at a time, so two saves cannot both decide they are the first.
  let saveQueue: Promise<unknown> = Promise.resolve();

  async function save(request: ResultWebhookSaveRequest): Promise<ResultWebhookIpcResult<ResultWebhookState>> {
    try {
      const stored = getStored(store);
      const enabled = request?.enabled === true;
      // Everything is validated before anything is changed.
      const target = resolveTarget(request, stored);
      const encryptedSecret = target.secret.kind === 'provided'
        ? encryptSecret(target.secret.secret)
        : target.secret.kind === 'stored' ? stored.encryptedSecret : undefined;

      let activatedAt = stored?.activatedAt;
      if (!activatedAt) {
        // The first save of this section, enabled or not, is the point
        // forwarding starts from. Decided here from the stored state, never
        // from what the renderer believes, and recorded only once the marking
        // has committed.
        const db = getDatabase();
        if (!db) {
          throw new ResultWebhookRequestError('database_unavailable', 'The local database is not open yet. Try again in a moment.');
        }
        await runSql(
          db,
          'UPDATE orders SET result_webhook_status = ? WHERE result_webhook_status = ?',
          [RESULT_WEBHOOK_STATUS.NOT_QUEUED, RESULT_WEBHOOK_STATUS.PENDING]
        ).catch(() => {
          throw new ResultWebhookRequestError('database_error', 'The local database could not be updated. Nothing was saved.');
        });
        activatedAt = new Date().toISOString();
      }

      const next: StoredResultWebhook = {
        schemaVersion: 1,
        enabled,
        url: target.url,
        authType: target.authType,
        username: target.username,
        activatedAt
      };
      if (encryptedSecret) next.encryptedSecret = encryptedSecret;
      if (stored && stored.url === target.url) {
        // Health only carries over while it still describes the same receiver.
        for (const key of ['health', 'lastDeliveredAt', 'lastCheckedAt', 'lastError'] as const) {
          if (stored[key] !== undefined) (next as any)[key] = stored[key];
        }
      }
      store.set(RESULT_WEBHOOK_KEY, next);
      return { ok: true, data: publicState(next) };
    } catch (error) {
      return errorResult(error);
    }
  }

  ipcMain.handle('result-webhook-get', () => ({
    ok: true,
    data: publicState(getStored(store))
  } satisfies ResultWebhookIpcResult<ResultWebhookState>));

  ipcMain.handle('result-webhook-save', (_event, request: ResultWebhookSaveRequest) => {
    const result = saveQueue.then(() => save(request));
    saveQueue = result.catch(() => undefined);
    return result;
  });

  // Tests the values in the form, saved or not, with an empty test batch.
  ipcMain.handle('result-webhook-test', async (_event, request: ResultWebhookSaveRequest) => {
    try {
      const stored = getStored(store);
      const target = resolveTarget(request, stored);
      const payload = buildResultWebhookPayload([], {
        batchId: randomUUID(),
        sentAt: new Date().toISOString(),
        source: sourceFor(store),
        test: true
      });
      const httpStatus = await post(
        target.url,
        authorizationHeaders(target, secretFor(target, stored)),
        JSON.stringify(payload)
      );
      return { ok: true, data: { httpStatus, delivered: 0 } } satisfies ResultWebhookIpcResult<ResultWebhookDelivery>;
    } catch (error) {
      return errorResult(error);
    }
  });

  ipcMain.handle('result-webhook-submit', async (_event, request: { results?: ResultWebhookResult[] }) => {
    const stored = getStored(store);
    if (!stored?.enabled) {
      return errorResult(new ResultWebhookRequestError('not_enabled', 'Result forwarding is turned off.'));
    }

    try {
      const results = request?.results;
      if (!isValidResultWebhookBatch(results)) {
        throw new ResultWebhookRequestError('invalid_result_batch', 'The result batch contains an invalid row.');
      }
      const target = resolveTarget(
        { enabled: true, url: stored.url, authType: stored.authType, username: stored.username },
        stored
      );
      const payload = buildResultWebhookPayload(results, {
        batchId: randomUUID(),
        sentAt: new Date().toISOString(),
        source: sourceFor(store)
      });
      const httpStatus = await post(
        target.url,
        authorizationHeaders(target, secretFor(target, stored)),
        JSON.stringify(payload)
      );
      const now = new Date().toISOString();
      recordHealth(store, target.url, { health: 'delivering', lastDeliveredAt: now, lastCheckedAt: now });
      return {
        ok: true,
        data: { httpStatus, delivered: results.length }
      } satisfies ResultWebhookIpcResult<ResultWebhookDelivery>;
    } catch (error) {
      const result = errorResult(error);
      recordHealth(store, stored.url, {
        health: 'attention',
        lastCheckedAt: new Date().toISOString(),
        lastError: result.error
      });
      return result;
    }
  });
}
