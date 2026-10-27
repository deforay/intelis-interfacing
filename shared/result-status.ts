// Result status: what the analyzer said about a result, as opposed to what the
// LIS did with it.
//
// orders.result_status keeps only "final or not", and HL7 results were always
// stored as final. The letter the analyzer sent is kept beside it
// (orders.result_status_as_sent): ASTM O.26, report type, or HL7 OBX.11,
// observation result status. The console shows it in words.

/** The status letter to store: trimmed, upper case, at most 10 characters. */
export function statusAsSent(value: unknown): string | null {
  const text = String(value ?? '').trim().toUpperCase().slice(0, 10);
  return text === '' ? null : text;
}

export type ResultStatusTone = 'final' | 'pending' | 'failed' | 'unknown';

export interface ResultStatusDisplay {
  label: string;
  title: string;
  tone: ResultStatusTone;
}

// Letters that mean the same in ASTM O.26 and HL7 OBX.11. A letter that
// differs between them, such as R, is shown as sent rather than guessed.
const STATUS_WORDS: Readonly<Record<string, { label: string; tone: ResultStatusTone }>> = Object.freeze({
  F: { label: 'Final', tone: 'final' },
  C: { label: 'Corrected', tone: 'final' },
  P: { label: 'Preliminary', tone: 'pending' },
  I: { label: 'Incomplete', tone: 'pending' },
  X: { label: 'Cannot be done', tone: 'failed' },
});

// Result values that name a run with no result, in the analyzers' own words.
// Compared without accents or case. The value is stored as sent: this list
// changes only what the status column shows.
const FAILED_RESULTS = new Set(['failed', 'error', 'invalid', 'no result', 'erreur', 'pas de resultat']);

function plain(value: unknown): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

/**
 * The status to show for a stored result. A result stored as Failed or
 * Incomplete shows that first, whatever letter came with it: a failed run must
 * never read as a final result.
 */
export function resultStatusDisplay(row: { results?: unknown; result_status_as_sent?: unknown }): ResultStatusDisplay {
  const letter = statusAsSent(row?.result_status_as_sent);
  const sent = letter ? ` The analyzer sent status ${letter}.` : '';
  const result = plain(row?.results);

  if (FAILED_RESULTS.has(result)) {
    return { label: 'Failed', title: `The analyzer reported a failed run.${sent}`, tone: 'failed' };
  }
  if (result === 'incomplete') {
    return { label: 'Incomplete', title: `The analyzer did not finish this test.${sent}`, tone: 'pending' };
  }
  if (!letter) {
    return { label: '-', title: 'The analyzer status is not kept for results captured before version 4.8.4.', tone: 'unknown' };
  }
  const known = STATUS_WORDS[letter];
  if (known) {
    return { label: known.label, title: `The analyzer sent this result as ${known.label.toLowerCase()} (${letter}).`, tone: known.tone };
  }
  return { label: `Status ${letter}`, title: `The analyzer sent status ${letter}.`, tone: 'unknown' };
}

/**
 * The status letter a stored result was read with, found again in its own
 * records (orders.raw_text). Used to fill in results captured before the
 * letter was kept. Returns null unless the answer is certain:
 * - HL7: every OBX segment carries the same OBX.11.
 * - ASTM: every order record carries the same O.26, or every order record
 *   for this sample ID does.
 */
export function statusFromRawText(rawText: unknown, orderId: unknown): string | null {
  const records = String(rawText ?? '')
    .split(/<CR>|\r\n|\r|\n/)
    // ASTM framing: a control character, then a frame number, before the record.
    .map(record => record.replace(/^[\x00-\x1f]*\d?/, ''))
    .filter(record => record !== '');

  const hl7 = records.filter(record => record.startsWith('OBX|')).map(record => record.split('|'));
  if (records.some(record => record.startsWith('MSH|'))) {
    return onlyLetter(hl7.map(fields => fields[11]));
  }

  const orders = records.filter(record => record.startsWith('O|')).map(record => record.split('|'));
  const all = onlyLetter(orders.map(fields => fields[25]));
  if (all) {
    return all;
  }
  const id = String(orderId ?? '').trim();
  return id === '' ? null : onlyLetter(orders.filter(fields => fields[2]?.trim() === id).map(fields => fields[25]));
}

/** The one letter all values share, or null when there is none or more than one. */
function onlyLetter(values: unknown[]): string | null {
  const letters = new Set(values.map(statusAsSent));
  if (letters.size !== 1 || letters.has(null)) {
    return null;
  }
  return [...letters][0];
}
