import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestartNoticeComponent } from './restart-notice.component';

describe('RestartNoticeComponent', () => {
  let restartRequired: BehaviorSubject<boolean>;
  let receiving: string[];
  let unsaved: boolean;
  let restart: ReturnType<typeof vi.fn>;

  const createComponent = () => {
    const component = new RestartNoticeComponent(
      { restartRequired$: restartRequired, performForceRerunMigrations: restart } as any,
      { instrumentsReceiving: () => receiving, hasUnsavedData: () => unsaved } as any,
      { ipcRenderer: { invoke: vi.fn().mockResolvedValue(undefined) } } as any,
      { showNotification: vi.fn() } as any,
      { detectChanges: vi.fn() } as any
    );
    component.ngOnInit();
    return component;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    restartRequired = new BehaviorSubject<boolean>(false);
    receiving = [];
    unsaved = false;
    restart = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays hidden until a restart is required', () => {
    const component = createComponent();
    vi.advanceTimersByTime(60_000);

    expect(component.visible).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it('counts down and restarts on its own', () => {
    const component = createComponent();
    restartRequired.next(true);

    expect(component.visible).toBe(true);
    vi.advanceTimersByTime((RestartNoticeComponent.COUNTDOWN_SECONDS - 1) * 1000);
    expect(component.secondsLeft).toBe(1);
    expect(restart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('restarts at once when the operator chooses to', () => {
    const component = createComponent();
    restartRequired.next(true);

    component.restartNow();
    component.restartNow();
    vi.advanceTimersByTime(60_000);

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('waits for an analyzer that is sending, then restarts', () => {
    const component = createComponent();
    receiving = ['GeneXpert'];
    restartRequired.next(true);

    vi.advanceTimersByTime((RestartNoticeComponent.COUNTDOWN_SECONDS + 10) * 1000);
    expect(restart).not.toHaveBeenCalled();
    expect(component.waitingFor).toEqual(['GeneXpert']);

    receiving = [];
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('waits for results still being saved after the sending ends, then restarts', () => {
    // An instrument stops counting as sending before its results are written.
    const component = createComponent();
    unsaved = true;
    restartRequired.next(true);

    vi.advanceTimersByTime((RestartNoticeComponent.COUNTDOWN_SECONDS + 5) * 1000);
    expect(restart).not.toHaveBeenCalled();
    expect(component.waitingForSaves).toBe(true);

    unsaved = false;
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('does not wait longer than the limit for a transmission that never ends', () => {
    createComponent();
    receiving = ['GeneXpert'];
    restartRequired.next(true);

    vi.advanceTimersByTime((RestartNoticeComponent.COUNTDOWN_SECONDS + RestartNoticeComponent.MAX_WAIT_SECONDS - 1) * 1000);
    expect(restart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
