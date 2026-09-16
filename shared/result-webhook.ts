// The result webhook: a generic, documented JSON POST of stored results to any
// HTTP receiver — an integration engine, a custom LIS endpoint, a script.
//
// Pure functions only, shared by the main process (which makes the request and
// holds the secret) and the renderer (which reads the queue). The payload shape
// is a published contract: see docs/technical/result-webhook.md before
// changing a field, and bump RESULT_WEBHOOK_SCHEMA_VERSION when you do.

export const RESULT_WEBHOOK_SCHEMA_VERSION = 1;
export const RESULT_WEBHOOK_MAX_ITEMS = 50;
export const RESULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export interface ResultWebhookBatchLimits {
  maxItems: number;
  maxBodyBytes: number;
}

export const RESULT_WEBHOOK_BATCH_LIMITS: Readonly<ResultWebhookBatchLimits> = Object.freeze({
  maxItems: RESULT_WEBHOOK_MAX_ITEMS,
  maxBodyBytes: RESULT_WEBHOOK_MAX_BODY_BYTES
});

export type ResultWebhookAuthType = 'none' | 'bearer' | 'basic' | 'apikey';
export type ResultWebhookHealth = 'delivering' | 'attention';

/** `orders.result_webhook_status`. Only a 2xx response moves a row to delivered. */
export const RESULT_WEBHOOK_STATUS = {
  PENDING: 0,
  DELIVERED: 1,
  // Already stored when the forwarding section was first saved. Never sent,
  // never reported as delivered.
  NOT_QUEUED: 2
} as const;

export interface ResultWebhookState {
  configured: boolean;
  enabled: boolean;
  url: string;
  authType: ResultWebhookAuthType;
  username: string;
  hasSecret: boolean;
  activatedAt?: string;
  health?: ResultWebhookHealth;
  lastDeliveredAt?: string;
  lastCheckedAt?: string;
  lastError?: ResultWebhookError;
}

export interface ResultWebhookSaveRequest {
  enabled: boolean;
  url: string;
  authType: ResultWebhookAuthType;
  username?: string;
  /** Omitted or empty keeps the saved secret, so the form never has to show it. */
  secret?: string;
}

/** What the main process stores under `resultWebhook`. The secret never leaves it. */
export interface StoredResultWebhook extends Omit<ResultWebhookState, 'configured' | 'hasSecret'> {
  schemaVersion: 1;
  encryptedSecret?: string;
}

/** Where the secret for a request comes from, once the rules below have been applied. */
export type ResultWebhookSecretSource =
  | { kind: 'none' }
  | { kind: 'provided'; secret: string }
  | { kind: 'stored' };

export interface ResolvedResultWebhookTarget {
  url: string;
  authType: ResultWebhookAuthType;
  username: string;
  secret: ResultWebhookSecretSource;
}

export class ResultWebhookValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Receiver statuses that describe the request's content rather than the
 * receiver's configuration. A batch refused with one of these is retried one
 * result at a time, so a single result the receiver will not take does not hold
 * back every result after it.
 */
export const RESULT_WEBHOOK_CONTENT_REJECTION_STATUSES: readonly number[] = [400, 413, 422];

export interface ResultWebhookError {
  code: string;
  message: string;
  httpStatus?: number;
}

export interface ResultWebhookIpcResult<T> {
  ok: boolean;
  data?: T;
  error?: ResultWebhookError;
}

/** One stored result, with every value exactly as it sits in `orders`. */
export interface ResultWebhookResult {
  id: number;
  ingestion_id: string;
  instrument_id: string | null;
  machine_used: string | null;
  order_id: string;
  test_id: string | null;
  test_type: string | null;
  test_description: string | null;
  test_location: string | null;
  results: string | null;
  /** The result as read from the transmission, before the laboratory's result rules. Null on results stored before 4.5.0. */
  results_as_sent: string | null;
  test_unit: string | null;
  result_status: number | null;
  notes: string | null;
  tested_by: string | null;
  repeated: number | null;
  analysed_date_time: string | null;
  specimen_date_time: string | null;
  authorised_date_time: string | null;
  result_accepted_date_time: string | null;
  added_on: string | null;
  raw_text: string | null;
}

export interface ResultWebhookSource {
  application: 'intelis-interfacing';
  appVersion: string | null;
  installationId: string | null;
  labId: string | null;
  labName: string | null;
}

export interface ResultWebhookPayload {
  schemaVersion: number;
  batchId: string;
  sentAt: string;
  test: boolean;
  source: ResultWebhookSource;
  results: ResultWebhookResult[];
}

export const RESULT_WEBHOOK_RESULT_FIELDS: readonly (keyof ResultWebhookResult)[] = [
  'id',
  'ingestion_id',
  'instrument_id',
  'machine_used',
  'order_id',
  'test_id',
  'test_type',
  'test_description',
  'test_location',
  'results',
  'results_as_sent',
  'test_unit',
  'result_status',
  'notes',
  'tested_by',
  'repeated',
  'analysed_date_time',
  'specimen_date_time',
  'authorised_date_time',
  'result_accepted_date_time',
  'added_on',
  'raw_text'
];

const NUMERIC_FIELDS = new Set<keyof ResultWebhookResult>(['id', 'result_status', 'repeated']);

export function isResultWebhookAuthType(value: unknown): value is ResultWebhookAuthType {
  return value === 'none' || value === 'bearer' || value === 'basic' || value === 'apikey';
}

/**
 * Plain HTTP is allowed: an engine on the same machine or LAN is the common
 * case. Credentials in the URL are not, because the URL is stored and shown
 * unencrypted.
 */
export function normalizeResultWebhookUrl(value: string): string {
  const trimmed = (value || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid receiver URL, including http:// or https://.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The receiver URL must start with http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Put credentials in the authentication fields, not in the URL.');
  }
  if (parsed.hash) {
    throw new Error('The receiver URL cannot contain a fragment.');
  }
  return parsed.toString();
}

export function isPlainHttpToAnotherHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    return parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(host);
  } catch {
    return false;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Validates a form submission and settles which secret applies, without
 * reading the secret itself.
 *
 * A blank secret reuses the saved one only for the same authentication type
 * and the same origin. Otherwise anyone at the machine could send the saved
 * token to a host of their choosing by changing the URL and pressing Send test.
 */
export function resolveResultWebhookTarget(
  request: Partial<ResultWebhookSaveRequest> | null | undefined,
  stored: StoredResultWebhook | null
): ResolvedResultWebhookTarget {
  const url = validatedReceiverUrl(request?.url);
  if (!isResultWebhookAuthType(request?.authType)) {
    throw new ResultWebhookValidationError('invalid_auth_type', 'Choose how the receiver authenticates requests.');
  }

  const authType = request.authType;
  const username = validatedUsername(authType, request.username);
  if (authType === 'none') {
    return { url, authType, username, secret: { kind: 'none' } };
  }

  const provided = typeof request.secret === 'string' ? request.secret : '';
  if (provided) {
    assertSecretCanBeSent(authType, provided);
    return { url, authType, username, secret: { kind: 'provided', secret: provided } };
  }

  if (stored?.encryptedSecret && stored.authType === authType && sameOrigin(stored.url, url)) {
    return { url, authType, username, secret: { kind: 'stored' } };
  }
  throw new ResultWebhookValidationError(
    'secret_required',
    stored?.encryptedSecret && stored.authType === authType
      ? 'The receiver address changed. Enter the secret again for the new receiver.'
      : 'Enter the receiver secret for this authentication type.'
  );
}

function validatedReceiverUrl(value: string | undefined): string {
  try {
    return normalizeResultWebhookUrl(value);
  } catch (error) {
    throw new ResultWebhookValidationError('invalid_url', error instanceof Error ? error.message : 'Enter a valid receiver URL.');
  }
}

function validatedUsername(authType: ResultWebhookAuthType, value: string | undefined): string {
  if (authType !== 'basic') return '';
  const username = (value || '').trim();
  if (!username || username.includes(':') || /[\r\n]/.test(username)) {
    throw new ResultWebhookValidationError('invalid_username', 'Enter a username without a colon for Basic authentication.');
  }
  return username;
}

/**
 * Bearer tokens and API keys travel as raw header values, which only carry
 * visible ASCII reliably. Basic credentials are base64-encoded first.
 */
function assertSecretCanBeSent(authType: ResultWebhookAuthType, secret: string): void {
  if (authType === 'basic' ? !/[\r\n]/.test(secret) : /^[\x21-\x7E]+$/.test(secret)) return;
  throw new ResultWebhookValidationError(
    'invalid_secret',
    authType === 'basic'
      ? 'The password cannot contain line breaks.'
      : 'The token or key can contain only visible ASCII characters, without spaces.'
  );
}

/**
 * Copies a row from `orders` into the published shape. Strings stay strings,
 * byte for byte: a result is never trimmed, parsed or reformatted here.
 */
export function toResultWebhookResult(record: Record<string, any>): ResultWebhookResult {
  const result = {} as Record<string, unknown>;
  for (const field of RESULT_WEBHOOK_RESULT_FIELDS) {
    const value = record?.[field];
    if (value === null || value === undefined) {
      result[field] = null;
    } else if (NUMERIC_FIELDS.has(field)) {
      const numeric = Number(value);
      result[field] = Number.isFinite(numeric) ? numeric : null;
    } else {
      result[field] = String(value);
    }
  }
  return result as unknown as ResultWebhookResult;
}

export function buildResultWebhookPayload(
  results: ResultWebhookResult[],
  meta: { batchId: string; sentAt: string; source: ResultWebhookSource; test?: boolean }
): ResultWebhookPayload {
  return {
    schemaVersion: RESULT_WEBHOOK_SCHEMA_VERSION,
    batchId: meta.batchId,
    sentAt: meta.sentAt,
    test: meta.test === true,
    source: meta.source,
    results
  };
}

export function resultWebhookBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Splits pending results into requests. A single result larger than the byte
 * limit still goes, alone: a long raw transmission is not a reason to hold a
 * result back forever, and whether to accept it is the receiver's decision.
 */
export function planResultWebhookBatches(
  results: ResultWebhookResult[],
  limits: ResultWebhookBatchLimits = RESULT_WEBHOOK_BATCH_LIMITS
): ResultWebhookResult[][] {
  const batches: ResultWebhookResult[][] = [];
  let current: ResultWebhookResult[] = [];
  let currentBytes = 0;

  for (const result of results) {
    const bytes = resultWebhookBytes(result);
    if (
      current.length > 0
      && (current.length >= limits.maxItems || currentBytes + bytes > limits.maxBodyBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(result);
    currentBytes += bytes;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** Guards the IPC boundary: what reaches the network must be rows this module built. */
export function isValidResultWebhookBatch(results: unknown): results is ResultWebhookResult[] {
  if (!Array.isArray(results) || results.length === 0) return false;
  const seen = new Set<number>();
  for (const row of results) {
    if (!isValidResultWebhookRow(row) || seen.has(row.id)) return false;
    seen.add(row.id);
  }
  return true;
}

const ALLOWED_RESULT_FIELDS = new Set<string>(RESULT_WEBHOOK_RESULT_FIELDS);

function isValidResultWebhookRow(row: unknown): row is ResultWebhookResult {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const record = row as Record<string, unknown>;
  return Object.keys(record).every(field => ALLOWED_RESULT_FIELDS.has(field))
    && Number.isInteger(record['id'])
    && typeof record['ingestion_id'] === 'string' && record['ingestion_id'] !== ''
    && typeof record['order_id'] === 'string'
    && RESULT_WEBHOOK_RESULT_FIELDS.every(field => hasPublishedType(field, record[field]));
}

function hasPublishedType(field: keyof ResultWebhookResult, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return NUMERIC_FIELDS.has(field) ? typeof value === 'number' : typeof value === 'string';
}
