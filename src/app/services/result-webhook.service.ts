import { Injectable } from '@angular/core';
import { ElectronService } from '../core/services';
import {
  ResultWebhookIpcResult,
  ResultWebhookResult,
  ResultWebhookSaveRequest,
  ResultWebhookState
} from '../../../shared/result-webhook';

export interface ResultWebhookDelivery {
  httpStatus: number;
  delivered: number;
}

/**
 * The renderer's side of the result webhook. The request itself, and the
 * secret, stay in the main process: see app/result-webhook.main.ts.
 */
@Injectable({ providedIn: 'root' })
export class ResultWebhookService {
  constructor(private readonly electron: ElectronService) {}

  load(): Promise<ResultWebhookIpcResult<ResultWebhookState>> {
    return this.invoke('result-webhook-get');
  }

  save(request: ResultWebhookSaveRequest): Promise<ResultWebhookIpcResult<ResultWebhookState>> {
    return this.invoke('result-webhook-save', request);
  }

  test(request: ResultWebhookSaveRequest): Promise<ResultWebhookIpcResult<ResultWebhookDelivery>> {
    return this.invoke('result-webhook-test', request);
  }

  submit(results: ResultWebhookResult[]): Promise<ResultWebhookIpcResult<ResultWebhookDelivery>> {
    return this.invoke('result-webhook-submit', { results });
  }

  private async invoke<T>(channel: string, payload?: unknown): Promise<ResultWebhookIpcResult<T>> {
    if (!this.electron.isElectron || !this.electron.ipcRenderer) {
      return {
        ok: false,
        error: { code: 'desktop_required', message: 'Result forwarding is available in the desktop application.' }
      };
    }
    try {
      return await this.electron.ipcRenderer.invoke(channel, payload);
    } catch {
      return {
        ok: false,
        error: { code: 'webhook_unavailable', message: 'The result forwarding service is unavailable.' }
      };
    }
  }
}
