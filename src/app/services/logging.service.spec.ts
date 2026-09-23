import { describe, expect, it, vi } from 'vitest';
import { LoggingService } from './logging.service';

describe('LoggingService message length', () => {
  const service = () => {
    const display = { log: vi.fn() };
    const logging = new LoggingService({ get: vi.fn() } as any, display as any, { isElectron: false } as any);
    logging.ngOnDestroy();
    return { logging, display };
  };

  it('logs a message within the limit unchanged', () => {
    const { logging, display } = service();
    const message = 'x'.repeat(LoggingService.MAX_MESSAGE_LENGTH);

    logging.log('info', message, 'ANALYZER-1');

    expect(display.log.mock.calls[0][0].message).toBe(message);
  });

  it('cuts a longer message, such as a whole received chunk, and says how much was left out', () => {
    const { logging, display } = service();

    logging.log('info', 'y'.repeat(64 * 1024), 'ANALYZER-1');

    const logged: string = display.log.mock.calls[0][0].message;
    expect(logged.startsWith('y'.repeat(LoggingService.MAX_MESSAGE_LENGTH) + '…')).toBe(true);
    expect(logged).toContain(`(${64 * 1024 - LoggingService.MAX_MESSAGE_LENGTH} more characters not logged)`);
    expect(logged.length).toBeLessThan(LoggingService.MAX_MESSAGE_LENGTH + 64);
  });
});
