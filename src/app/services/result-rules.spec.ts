import { describe, expect, it } from 'vitest';
import {
  applyResultRules,
  effectiveResultRules,
  LEGACY_HL7_RESULT_RULES,
  normalizeResultRules,
  ResultRule
} from '../../../shared/result-rules';

describe('result rules', () => {
  describe('which rules an instrument is read with', () => {
    it('reads an HL7 instrument saved before rules existed with the rewrites the parser used to apply', () => {
      expect(effectiveResultRules({ interfaceCommunicationProtocol: 'hl7' })).toEqual([...LEGACY_HL7_RESULT_RULES]);
    });

    it('reads an instrument whose rules were saved with exactly those rules, even none', () => {
      expect(effectiveResultRules({ interfaceCommunicationProtocol: 'hl7', resultRules: [] })).toEqual([]);
    });

    it('gives an ASTM instrument no rules unless it has saved some', () => {
      expect(effectiveResultRules({ interfaceCommunicationProtocol: 'astm-checksum' })).toEqual([]);
      expect(effectiveResultRules(undefined, 'astm-nonchecksum')).toEqual([]);
    });

    it('falls back to the protocol when the instrument cannot be found', () => {
      expect(effectiveResultRules(undefined, 'hl7')).toEqual([...LEGACY_HL7_RESULT_RULES]);
    });

    it('does not hand out the shared defaults for editing', () => {
      const rules = effectiveResultRules(undefined, 'hl7');
      rules[0].replaceWith = 'changed';
      expect(LEGACY_HL7_RESULT_RULES[0].replaceWith).toBe('> 10000000');
    });

    it('drops rules with nothing to match, which would match every result', () => {
      expect(normalizeResultRules([
        { match: 'contains', value: '', replaceWith: 'X' },
        { match: 'exact', value: '   ', replaceWith: 'X' },
        { match: 'regex', value: 'a', replaceWith: 'X' },
        null,
        { match: 'exact', value: 'Invalid', replaceWith: 'Failed', ignoreCase: 'yes' }
      ])).toEqual([{ match: 'exact', value: 'Invalid', replaceWith: 'Failed' }]);
    });
  });

  describe('applying rules', () => {
    const rules: ResultRule[] = [
      { match: 'exact', value: '> Titer max', replaceWith: '> 10000000' },
      { match: 'contains', value: 'not detected', replaceWith: 'Target Not Detected', ignoreCase: true },
      { match: 'contains', value: 'Detected', replaceWith: 'never reached for "Not Detected"' }
    ];

    it('replaces the whole value when an exact rule matches, ignoring surrounding spaces', () => {
      expect(applyResultRules(' > Titer max ', rules).value).toBe('> 10000000');
    });

    it('does not treat a longer value as an exact match', () => {
      expect(applyResultRules('> Titer max 2', rules).value).toBe('> Titer max 2');
    });

    it('matches contains rules anywhere, and ignores case only when asked', () => {
      expect(applyResultRules('NON DETECTED / NOT DETECTED', rules).value).toBe('Target Not Detected');
      expect(applyResultRules('Detected', rules).value).toBe('never reached for "Not Detected"');
    });

    it('uses the first rule that matches', () => {
      expect(applyResultRules('Not Detected', rules).rule).toBe(rules[1]);
    });

    it('stores a value no rule matches exactly as sent, numbers included', () => {
      for (const value of ['1250', '3.26E+05 cp/mL', '< 20', '', null, undefined]) {
        expect(applyResultRules(value, rules)).toEqual({ value, rule: null });
      }
    });

    it('never replaces a result that says the run failed or is incomplete', () => {
      const anything: ResultRule[] = [
        { match: 'exact', value: 'Failed', replaceWith: 'Not Detected' },
        { match: 'contains', value: 'incomplete', replaceWith: 'Not Detected', ignoreCase: true }
      ];
      expect(applyResultRules('Failed', anything)).toEqual({ value: 'Failed', rule: null });
      expect(applyResultRules(' INCOMPLETE ', anything)).toEqual({ value: ' INCOMPLETE ', rule: null });
    });

    it('drops a rule with nothing to store, rather than storing an empty result', () => {
      const rules = normalizeResultRules([{ match: 'exact', value: '<20', replaceWith: '  ' }]);
      expect(rules).toEqual([]);
      expect(applyResultRules('<20', rules).value).toBe('<20');
    });

    it('takes the replacement literally', () => {
      expect(applyResultRules('<20', [{ match: 'exact', value: '<20', replaceWith: '$1 $& <' }]).value).toBe('$1 $& <');
    });
  });
});
