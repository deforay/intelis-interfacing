import { Pipe, PipeTransform } from '@angular/core';
import { formatDisplayDateTime } from '../../../shared/date-display';
import { ElectronStoreService } from '../services/electron-store.service';

/**
 * Shows a stored date and time in the format chosen in Settings. The stored
 * value is not changed, so sorting, searching and the LIS still use it.
 * Settings are read when a view is created; saving Settings returns to a
 * freshly created console, which picks the new format up.
 */
@Pipe({ name: 'displayDateTime', standalone: false })
export class DisplayDateTimePipe implements PipeTransform {
  constructor(private readonly store: ElectronStoreService) {}

  transform(value: unknown): string {
    const format = this.store?.get?.('commonConfig')?.dateFormat;
    return formatDisplayDateTime(value, format);
  }
}
