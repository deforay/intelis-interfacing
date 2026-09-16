import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ElectronStoreService {
  private store: any;
  private electronStoreSubject: BehaviorSubject<any>;

  constructor() {
    if (window.require) {
      try {
        const storeClass = window.require('electron-store');
        this.store = new storeClass();
        this.electronStoreSubject = new BehaviorSubject<any>(this.getAll());
      } catch (e) {
        console.warn('electron-store was not loaded');
        this.electronStoreSubject = new BehaviorSubject<any>(null);
      }
    } else {
      console.warn('electron-store was not loaded');
      this.electronStoreSubject = new BehaviorSubject<any>(null);
    }
  }

  get = (key: string): any => this.store.get(key);

  set = (key: string, value: any): void => {
    this.store.set(key, value);
    this.electronStoreSubject.next(this.getAll());
  };

  // getAll(): any {
  //   return this.store.store;
  // }

  getAll(): any {
    const storeCopy = { ...this.store.store };

    if (storeCopy.encryptionKey) {
      delete storeCopy.encryptionKey;
    }
    // Connection identity and credentials are managed exclusively in Electron
    // main and must not flow through renderer settings snapshots or exports.
    delete storeCopy.intelisConnection;
    delete storeCopy.sourceInstallationId;
    delete storeCopy.resultWebhook;

    return storeCopy;
  }

  electronStoreObservable(): Observable<any> {
    return this.electronStoreSubject.asObservable();
  }

  /**
   * Writes a settings file. The main process reads the store, scrubs or
   * encrypts, and writes: the passphrase is the only sensitive value that
   * crosses IPC, and the credentials themselves never come back here.
   *
   * Without `includeCredentials` the file is scrubbed, exactly as before.
   */
  exportSettings(options?: { includeCredentials?: boolean; passphrase?: string }): Promise<any> {
    return (window as any).require('electron').ipcRenderer.invoke('export-settings', {
      includeCredentials: options?.includeCredentials === true,
      passphrase: options?.passphrase ?? ''
    });
  }

  showNotification(title: string, message: string): void {
    new Notification(title, { body: message });
  }

}
