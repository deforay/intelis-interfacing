// How dates are shown on screen. Display only: the database, raw data, the
// LIS and sorting keep the stored form (YYYY-MM-DD HH:mm:ss).

export type DateDisplayFormat =
  | 'DD-MMM-YYYY'
  | 'DD-MM-YYYY'
  | 'DD/MM/YYYY'
  | 'DD.MM.YYYY'
  | 'MM/DD/YYYY'
  | 'YYYY-MM-DD';

export const DEFAULT_DATE_DISPLAY_FORMAT: DateDisplayFormat = 'DD-MMM-YYYY';

export const DATE_DISPLAY_FORMATS: readonly DateDisplayFormat[] = Object.freeze([
  'DD-MMM-YYYY',
  'DD-MM-YYYY',
  'DD/MM/YYYY',
  'DD.MM.YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DD'
]) as readonly DateDisplayFormat[];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isDateDisplayFormat(value: unknown): value is DateDisplayFormat {
  return typeof value === 'string' && (DATE_DISPLAY_FORMATS as readonly string[]).includes(value);
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  time: string | null;
}

const two = (value: number) => String(value).padStart(2, '0');

/**
 * Reads the date and time exactly as written, with no time zone conversion:
 * "2026-09-16 13:47:03" is shown as 13:47:03 on every computer.
 */
function parseStored(value: string): DateParts | null {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const time = match[4] === undefined ? null : `${match[4]}:${match[5]}:${match[6] ?? '00'}`;
  return { year, month, day, time };
}

function datePart(parts: DateParts, format: DateDisplayFormat): string {
  const dd = two(parts.day);
  const mm = two(parts.month);
  const yyyy = String(parts.year).padStart(4, '0');
  switch (format) {
    case 'DD-MM-YYYY': return `${dd}-${mm}-${yyyy}`;
    case 'DD/MM/YYYY': return `${dd}/${mm}/${yyyy}`;
    case 'DD.MM.YYYY': return `${dd}.${mm}.${yyyy}`;
    case 'MM/DD/YYYY': return `${mm}/${dd}/${yyyy}`;
    case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
    default: return `${dd}-${MONTHS[parts.month - 1]}-${yyyy}`;
  }
}

/**
 * A stored date and time in the chosen format. A value that is not a
 * recognisable date is returned unchanged rather than hidden; an empty value
 * gives an empty string.
 */
export function formatDisplayDateTime(value: unknown, format: unknown = DEFAULT_DATE_DISPLAY_FORMAT): string {
  if (value === null || value === undefined || value === '') return '';
  const chosen = isDateDisplayFormat(format) ? format : DEFAULT_DATE_DISPLAY_FORMAT;
  let parts: DateParts | null;
  if (value instanceof Date) {
    parts = Number.isNaN(value.getTime())
      ? null
      : {
          year: value.getFullYear(),
          month: value.getMonth() + 1,
          day: value.getDate(),
          time: `${two(value.getHours())}:${two(value.getMinutes())}:${two(value.getSeconds())}`
        };
  } else {
    parts = parseStored(String(value));
  }
  if (!parts) return String(value);
  const date = datePart(parts, chosen);
  return parts.time ? `${date} ${parts.time}` : date;
}

/** The label for a format in Settings: today's date written that way, then the pattern. */
export function dateDisplayFormatLabel(format: DateDisplayFormat, today: Date = new Date()): string {
  return `${formatDisplayDateTime(new Date(today.getFullYear(), today.getMonth(), today.getDate()), format).split(' ')[0]} (${format})`;
}
