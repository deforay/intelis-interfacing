// Result rules: a laboratory's own instructions for reading a result value,
// per instrument. "If the analyzer sends X, store Y."
//
// The tool itself stores what the analyzer sent. A rule is how a laboratory
// says its LIS expects something else, and it is theirs to write: the result as
// read before any rule is always kept beside the stored one
// (orders.results_as_sent), no rule touches a failed or incomplete run, and the
// raw transmission is never touched, so a rule can be changed and a
// transmission reprocessed.

export type ResultRuleMatch = 'exact' | 'contains';

export interface ResultRule {
  /** exact: the whole value; contains: anywhere in the value. */
  match: ResultRuleMatch;
  /** The text to look for in the value the analyzer sent. */
  value: string;
  /** What to store instead of the whole value. */
  replaceWith: string;
  /** Match regardless of upper and lower case. */
  ignoreCase?: boolean;
}

/**
 * The rewrites the HL7 parsers used to apply in code, as rules. An HL7
 * instrument saved before rules existed has no `resultRules` at all and is
 * read with these, so nothing it sends to the LIS changes on upgrade. Once its
 * settings are saved, the rules shown are the rules stored, and the laboratory
 * can edit or remove them.
 */
export const LEGACY_HL7_RESULT_RULES: readonly ResultRule[] = Object.freeze([
  Object.freeze({ match: 'exact', value: '> Titer max', replaceWith: '> 10000000' }),
  Object.freeze({ match: 'exact', value: '<20', replaceWith: '< 20' })
]) as readonly ResultRule[];

export interface InstrumentWithRules {
  interfaceCommunicationProtocol?: string;
  resultRules?: unknown;
}

function isHL7(protocol: string | undefined): boolean {
  return protocol === 'hl7';
}

/**
 * Keeps only complete rules. A rule with nothing to match would match every
 * result, and one with nothing to store would store an empty result, so both
 * are dropped rather than applied.
 */
export function normalizeResultRules(rules: unknown): ResultRule[] {
  if (!Array.isArray(rules)) return [];
  const normalized: ResultRule[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const candidate = rule as Record<string, unknown>;
    const match = candidate['match'] === 'contains' ? 'contains' : candidate['match'] === 'exact' ? 'exact' : null;
    const value = typeof candidate['value'] === 'string' ? candidate['value'] : '';
    const replaceWith = typeof candidate['replaceWith'] === 'string' ? candidate['replaceWith'] : '';
    if (!match || value.trim() === '' || replaceWith.trim() === '') continue;
    normalized.push({ match, value, replaceWith, ...(candidate['ignoreCase'] === true ? { ignoreCase: true } : {}) });
  }
  return normalized;
}

/**
 * The rules an instrument's results are read with. `protocol` is used when
 * the instrument's settings cannot be found, as for a connection whose
 * settings have since been removed.
 */
export function effectiveResultRules(instrument: InstrumentWithRules | null | undefined, protocol?: string): ResultRule[] {
  if (instrument && Array.isArray(instrument.resultRules)) {
    return normalizeResultRules(instrument.resultRules);
  }
  const instrumentProtocol = instrument?.interfaceCommunicationProtocol ?? protocol;
  return isHL7(instrumentProtocol) ? LEGACY_HL7_RESULT_RULES.map(rule => ({ ...rule })) : [];
}

function comparable(text: string, ignoreCase: boolean | undefined): string {
  const trimmed = text.trim();
  // Not toLocaleLowerCase: a rule must match the same way on every computer.
  return ignoreCase ? trimmed.toLowerCase() : trimmed;
}

export function resultRuleMatches(rule: ResultRule, value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const needle = comparable(rule.value, rule.ignoreCase);
  if (needle === '') return false;
  const haystack = comparable(value, rule.ignoreCase);
  return rule.match === 'exact' ? haystack === needle : haystack.includes(needle);
}

/**
 * Results that say a run did not produce a result. No rule applies to them: a
 * rule must never be able to make a failed run read as a result.
 */
export const RESULTS_NEVER_REWRITTEN: readonly string[] = Object.freeze(['failed', 'incomplete']);

/**
 * The value to store for what the analyzer sent. The first rule that matches
 * decides; a value no rule matches is stored as sent. The replacement is taken
 * literally, so a rule can never produce anything its author did not type.
 */
export function applyResultRules(
  value: string | null | undefined,
  rules: readonly ResultRule[]
): { value: string | null | undefined; rule: ResultRule | null } {
  if (typeof value === 'string' && RESULTS_NEVER_REWRITTEN.includes(value.trim().toLowerCase())) {
    return { value, rule: null };
  }
  for (const rule of rules) {
    if (resultRuleMatches(rule, value)) {
      return { value: rule.replaceWith, rule };
    }
  }
  return { value, rule: null };
}
