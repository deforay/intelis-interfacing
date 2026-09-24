import { describe, expect, it } from 'vitest';
import {
  effectiveTimeZone,
  formatInTimeZone,
  isTimeZone,
  listTimeZones,
  systemTimeZone,
  timeZoneOffsetLabel
} from '../../../shared/time-zone';

describe('time zone for received times', () => {
  const moment = new Date('2026-09-24T22:15:09Z');

  it('writes a moment as the wall-clock time in the chosen zone', () => {
    expect(formatInTimeZone(moment, 'UTC')).toBe('2026-09-24 22:15:09');
    expect(formatInTimeZone(moment, 'Asia/Kolkata')).toBe('2026-09-25 03:45:09');
    expect(formatInTimeZone(moment, 'America/New_York')).toBe('2026-09-24 18:15:09');
    expect(formatInTimeZone(new Date('2026-01-01T00:00:00Z'), 'Africa/Nairobi')).toBe('2026-01-01 03:00:00');
  });

  it('writes midnight as 00, not 24', () => {
    expect(formatInTimeZone(new Date('2026-09-24T00:00:05Z'), 'UTC')).toBe('2026-09-24 00:00:05');
  });

  it('falls back to the computer zone when none, or an unknown one, is set', () => {
    const expected = formatInTimeZone(moment, systemTimeZone());
    expect(formatInTimeZone(moment, undefined)).toBe(expected);
    expect(formatInTimeZone(moment, 'Mars/Olympus_Mons')).toBe(expected);
    expect(effectiveTimeZone('')).toBe(systemTimeZone());
  });

  it('accepts only zone names the computer knows', () => {
    expect(isTimeZone('Africa/Kampala')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Nowhere/City')).toBe(false);
    expect(isTimeZone(42)).toBe(false);
  });

  it('lists UTC and the computer zone among sorted zone names', () => {
    const zones = listTimeZones();
    expect(zones).toContain('UTC');
    expect(zones).toContain(systemTimeZone());
    expect(zones).toContain('Africa/Kinshasa');
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
  });

  it('labels the offset from UTC at a moment, following daylight saving', () => {
    expect(timeZoneOffsetLabel('UTC', moment)).toBe('UTC');
    expect(timeZoneOffsetLabel('Asia/Kolkata', moment)).toBe('UTC+05:30');
    expect(timeZoneOffsetLabel('America/New_York', moment)).toBe('UTC-04:00');
    expect(timeZoneOffsetLabel('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe('UTC-05:00');
  });
});
