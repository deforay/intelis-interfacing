// The time zone for times this tool stamps itself, such as when a result or
// transmission was received. Times sent by an analyzer are stored as sent and
// never pass through here.

const two = (value: number) => String(value).padStart(2, '0');

/** The computer's own time zone, or UTC when it cannot be read. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** True for a time zone name this computer can convert to. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The chosen zone when it is valid, otherwise the computer's own zone. */
export function effectiveTimeZone(chosen: unknown): string {
  return isTimeZone(chosen) ? chosen : systemTimeZone();
}

/** Every time zone name this computer knows, with UTC, sorted. */
export function listTimeZones(): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as any).supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return [...new Set(['UTC', systemTimeZone(), ...zones])].sort();
}

function zoneParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

/**
 * A moment as the wall-clock time in a zone, in the stored form
 * YYYY-MM-DD HH:mm:ss. An unknown zone falls back to the computer's own.
 */
export function formatInTimeZone(date: Date, timeZone: unknown): string {
  const p = zoneParts(date, effectiveTimeZone(timeZone));
  return `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

/** The zone's offset from UTC at a moment, such as "UTC+05:30". */
export function timeZoneOffsetLabel(timeZone: string, date: Date = new Date()): string {
  const p = zoneParts(date, timeZone);
  const wallClock = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const minutes = Math.round((wallClock - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `UTC${sign}${two(Math.floor(absolute / 60))}:${two(absolute % 60)}`;
}
