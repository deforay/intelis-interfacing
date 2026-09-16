import { describe, expect, it } from 'vitest';
import {
  DATE_DISPLAY_FORMATS,
  dateDisplayFormatLabel,
  DEFAULT_DATE_DISPLAY_FORMAT,
  formatDisplayDateTime
} from '../../../shared/date-display';

describe('date display format', () => {
  const stored = '2026-09-16 13:47:03';

  it('writes a stored date and time in every format, keeping the time as stored', () => {
    expect(DATE_DISPLAY_FORMATS.map(format => formatDisplayDateTime(stored, format))).toEqual([
      '16-Sep-2026 13:47:03',
      '16-09-2026 13:47:03',
      '16/09/2026 13:47:03',
      '16.09.2026 13:47:03',
      '09/16/2026 13:47:03',
      '2026-09-16 13:47:03'
    ]);
  });

  it('defaults to DD-MMM-YYYY when no format, or an unknown one, is set', () => {
    expect(DEFAULT_DATE_DISPLAY_FORMAT).toBe('DD-MMM-YYYY');
    expect(formatDisplayDateTime(stored)).toBe('16-Sep-2026 13:47:03');
    expect(formatDisplayDateTime(stored, 'YYYY/DD/MM')).toBe('16-Sep-2026 13:47:03');
  });

  it('reads the stored forms without shifting the time zone', () => {
    expect(formatDisplayDateTime('2026-01-02T23:59:58Z', 'DD-MM-YYYY')).toBe('02-01-2026 23:59:58');
    expect(formatDisplayDateTime('20260102235958', 'DD-MM-YYYY')).toBe('02-01-2026 23:59:58');
    expect(formatDisplayDateTime('2026-01-02', 'DD/MM/YYYY')).toBe('02/01/2026');
  });

  it('shows a value that is not a date as it is, and nothing for an empty one', () => {
    expect(formatDisplayDateTime('not recorded', 'DD-MM-YYYY')).toBe('not recorded');
    expect(formatDisplayDateTime('2026-13-40 10:00:00', 'DD-MM-YYYY')).toBe('2026-13-40 10:00:00');
    for (const empty of [null, undefined, '']) {
      expect(formatDisplayDateTime(empty, 'DD-MM-YYYY')).toBe('');
    }
  });

  it('labels each option with today\'s date written that way', () => {
    const today = new Date(2026, 8, 16, 18, 30);
    expect(dateDisplayFormatLabel('DD-MMM-YYYY', today)).toBe('16-Sep-2026 (DD-MMM-YYYY)');
    expect(dateDisplayFormatLabel('MM/DD/YYYY', today)).toBe('09/16/2026 (MM/DD/YYYY)');
  });
});
