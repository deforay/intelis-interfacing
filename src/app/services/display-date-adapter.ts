import { inject, Injectable } from '@angular/core';
import { MatDateFormats, NativeDateAdapter } from '@angular/material/core';
import { formatDisplayDate, parseDisplayDate } from '../../../shared/date-display';
import { ElectronStoreService } from './electron-store.service';

/** The display format name the date adapter treats as "the Settings format". */
const SETTINGS_FORMAT = 'settings';

/**
 * Date fields write and read days in the Display Date Format from Settings.
 * The calendar's own labels, such as month names, stay as the native adapter
 * writes them.
 */
@Injectable()
export class DisplayDateAdapter extends NativeDateAdapter {
  private readonly store = inject(ElectronStoreService);

  private get settingsFormat(): unknown {
    return this.store?.get?.('commonConfig')?.dateFormat;
  }

  override format(date: Date, displayFormat: object | string): string {
    return displayFormat === SETTINGS_FORMAT ? formatDisplayDate(date, this.settingsFormat) : super.format(date, displayFormat as object);
  }

  override parse(value: unknown): Date | null {
    if (value instanceof Date) return value;
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return this.invalid();
    return parseDisplayDate(value, this.settingsFormat) ?? this.invalid();
  }
}

export const DISPLAY_DATE_FORMATS: MatDateFormats = {
  parse: { dateInput: SETTINGS_FORMAT },
  display: {
    dateInput: SETTINGS_FORMAT,
    monthLabel: { month: 'short' },
    monthYearLabel: { year: 'numeric', month: 'short' },
    dateA11yLabel: { year: 'numeric', month: 'long', day: 'numeric' },
    monthYearA11yLabel: { year: 'numeric', month: 'long' }
  }
};
