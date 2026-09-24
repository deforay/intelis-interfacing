import { describe, expect, it } from 'vitest';
import {
  DATE_DISPLAY_FORMATS,
  dateDisplayFormatLabel,
  DEFAULT_DATE_DISPLAY_FORMAT,
  formatDisplayDate,
  formatDisplayDateTime,
  parseDisplayDate
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

  it('shows a value that is only partly a date, or an impossible one, exactly as stored', () => {
    for (const value of ['2026-09-16garbage', '2026-02-31 10:00:00', '2026-09-16 24:00:00', '2026-09-16 1:05:00', '2026091612345678']) {
      expect(formatDisplayDateTime(value, 'DD-MM-YYYY'), value).toBe(value);
    }
    expect(formatDisplayDateTime('2026-09-16 13:47:03.123', 'DD-MM-YYYY')).toBe('16-09-2026 13:47:03');
    expect(formatDisplayDateTime('2028-02-29', 'DD-MMM-YYYY')).toBe('29-Feb-2028');
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

describe('date fields in the display format', () => {
  const day = new Date(2026, 8, 9);

  it('writes a day in every format', () => {
    expect(DATE_DISPLAY_FORMATS.map(format => formatDisplayDate(day, format))).toEqual([
      '09-Sep-2026', '09-09-2026', '09/09/2026', '09.09.2026', '09/09/2026', '2026-09-09'
    ]);
    expect(formatDisplayDate(new Date(2026, 0, 31), 'MM/DD/YYYY')).toBe('01/31/2026');
  });

  it('reads back what it writes, in every format', () => {
    for (const format of DATE_DISPLAY_FORMATS) {
      expect(parseDisplayDate(formatDisplayDate(new Date(2026, 0, 31), format), format)).toEqual(new Date(2026, 0, 31));
    }
  });

  it('reads the day and month in the order of the chosen format', () => {
    expect(parseDisplayDate('03/04/2026', 'DD/MM/YYYY')).toEqual(new Date(2026, 3, 3));
    expect(parseDisplayDate('03/04/2026', 'MM/DD/YYYY')).toEqual(new Date(2026, 2, 4));
    expect(parseDisplayDate('3-sep-2026', 'DD-MMM-YYYY')).toEqual(new Date(2026, 8, 3));
    expect(parseDisplayDate('3 9 2026', 'DD.MM.YYYY')).toEqual(new Date(2026, 8, 3));
  });

  it('refuses text that is not a real day in the chosen format', () => {
    expect(parseDisplayDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDisplayDate('13/13/2026', 'MM/DD/YYYY')).toBeNull();
    expect(parseDisplayDate('2026-09-09', 'DD-MM-YYYY')).toBeNull();
    expect(parseDisplayDate('09-Sept-2026', 'DD-MMM-YYYY')).toBeNull();
    expect(parseDisplayDate('', 'DD-MMM-YYYY')).toBeNull();
  });
});
