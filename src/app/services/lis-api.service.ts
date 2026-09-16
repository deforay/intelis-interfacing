import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { ElectronStoreService } from './electron-store.service';
import { CryptoService } from './crypto.service';
import { LisApiConfig, LisApiResponse } from '../interfaces/lis-api-config.interface';

@Injectable({
  providedIn: 'root'
})
export class LisApiService {
  private instrumentNames$ = new BehaviorSubject<string[]>([]);

  constructor(
    private readonly http: HttpClient,
    private readonly electronStoreService: ElectronStoreService,
    private readonly cryptoService: CryptoService
  ) {
    this.loadAndFetch();
  }

  getInstrumentNames(): Observable<string[]> {
    return this.instrumentNames$.asObservable();
  }

  getCurrentInstrumentNames(): string[] {
    return this.instrumentNames$.getValue();
  }

  testAndFetch(config: LisApiConfig): Observable<string[]> {
    if (!config.url || !config.fetchInstruments?.enabled) {
      return of([]);
    }

    const url = this.buildUrl(config.url, config.fetchInstruments.endpoint || '/api/instruments');
    const headers = this.buildHeaders(config);

    return this.http.get<LisApiResponse>(url, { headers }).pipe(
      map(response => {
        const names = (response.instruments || []).map(i => i.name).filter(Boolean);
        this.instrumentNames$.next(names);
        return names;
      }),
      catchError(error => {
        const message = error.status
          ? `HTTP ${error.status}: ${error.statusText || 'Request failed'}`
          : error.message || 'Unable to connect to LIS API';
        throw new Error(message);
      })
    );
  }

  private buildUrl(baseUrl: string, endpoint: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    const path = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    return base + path;
  }

  private buildHeaders(config: LisApiConfig): HttpHeaders {
    let headers = new HttpHeaders({ 'Accept': 'application/json' });

    switch (config.authType) {
      case 'bearer':
        if (config.credentials?.token) {
          headers = headers.set('Authorization', `Bearer ${config.credentials.token}`);
        }
        break;
      case 'basic':
        if (config.credentials?.username) {
          const encoded = btoa(`${config.credentials.username}:${config.credentials.password || ''}`);
          headers = headers.set('Authorization', `Basic ${encoded}`);
        }
        break;
      case 'apikey':
        if (config.credentials?.apiKey) {
          headers = headers.set('X-API-Key', config.credentials.apiKey);
        }
        break;
    }

    return headers;
  }

  private loadAndFetch(): void {
    const config = this.electronStoreService.get('lisApiConfig') as LisApiConfig;
    if (!config?.url || !config.fetchInstruments?.enabled) {
      return;
    }

    // Decrypt credentials before fetching
    const decryptedConfig: LisApiConfig = {
      ...config,
      credentials: {
        token: this.cryptoService.decrypt(config.credentials?.token || ''),
        username: this.cryptoService.decrypt(config.credentials?.username || ''),
        password: this.cryptoService.decrypt(config.credentials?.password || ''),
        apiKey: this.cryptoService.decrypt(config.credentials?.apiKey || '')
      }
    };

    this.testAndFetch(decryptedConfig).subscribe({
      error: (err) => console.warn('LIS API auto-fetch failed:', err.message)
    });
  }
}
