import { Injectable } from '@angular/core';
import { DatabaseService } from './database.service';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { ElectronService } from '../core/services';
import { LoggingService, LogOptions } from './logging.service';
import { ElectronStoreService } from './electron-store.service';
import { formatDisplayDateTime } from '../../../shared/date-display';

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'verbose';

@Injectable({
  providedIn: 'root'
})

export class UtilitiesService {


  private readonly moment = require('moment');
  protected timer = null;
  protected logtext = [];

  protected logTextMap = new Map<string, BehaviorSubject<string[]>>();

  protected lastOrdersSubject = new BehaviorSubject([]);
  lastOrders = this.lastOrdersSubject.asObservable();


  protected lastrawDataSubject = new BehaviorSubject([]);
  lastrawData = this.lastrawDataSubject.asObservable();

  constructor(
    private readonly electronService: ElectronService,
    private readonly dbService: DatabaseService,
    private readonly loggingService: LoggingService,
    private readonly store?: ElectronStoreService
  ) {
  }

  checkMysqlConnection(mysqlParams: { host: string, user: string, password: string, port: string }, successCallback: Function, errorCallback: Function): void {
    this.dbService.checkMysqlConnection(mysqlParams, successCallback, errorCallback);
  }


  resyncTestResultsToMySQL(success, errorf) {
    this.dbService.resyncTestResultsToMySQL(success, errorf);
  }

  resyncTelemetryToMySQL(success, errorf) {
    this.dbService.resyncTelemetryToMySQL(success, errorf);
  }

  syncLimsStatusToSQLite(
    success: (result: { updatedCount: number; message: string }) => void,
    errorf: any
  ) {
    this.dbService.syncLimsStatusToSQLite(success, errorf);
  }

  sqlite3WalCheckpoint() {
    this.dbService.sqlite3WalCheckpoint();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  logger(type: LogLevel, message: string, instrumentId: string, options?: LogOptions) {
    this.loggingService.log(type, message, instrumentId, options);
  }

  humanReadableDateTime(date: Date | string | null): string {
    if (!date) {
      return '';
    }

    // Parsed as before, then written in the format chosen in Settings.
    const stored = this.formatRawDate(date, 'YYYY-MM-DD HH:mm:ss');
    return stored ? formatDisplayDateTime(stored, this.store?.get?.('commonConfig')?.dateFormat) : '';
  }

  hex2ascii(hexx) {
    const hex = hexx.toString(); // force conversion
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }

    return str;
  }

  arrayKeyExists(key, search) {
    //  discuss at: http://locutus.io/php/arrayKeyExists/
    // original by: Kevin van Zonneveld (http://kvz.io)
    // improved by: Felix Geisendoerfer (http://www.debuggable.com/felix)
    //   example 1: arrayKeyExists('kevin', {'kevin': 'van Zonneveld'})
    //   returns 1: true

    if (!search || (search.constructor !== Array && search.constructor !== Object)) {
      return false
    }

    return key in search
  }

  decodeHtmlEntities(text: string): string {
    if (!text || typeof text !== 'string') return text;

    // Only decode if HTML entities are detected
    if (text.includes('&')) {
      return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
    }
    return text;
  }

  /**
 * Formats raw date strings from medical instruments (YYYYMMDD or YYYYMMDDHHmmss format)
 * @param rawDate Raw date string from instrument
 * @returns Formatted date string (YYYY-MM-DD HH:mm:ss) or null if invalid
 */
  /**
 * Universal date formatter - handles raw instrument dates, ISO dates, Date objects, and more
 * @param rawDate Date in any format (YYYYMMDD, YYYYMMDDHHmmss, ISO string, Date object, etc.)
 * @param outputFormat Optional output format (defaults to 'YYYY-MM-DD HH:mm:ss')
 * @returns Formatted date string or null if invalid
 */
  formatRawDate(rawDate: string | Date | null | undefined, outputFormat: string = 'YYYY-MM-DD HH:mm:ss'): string | null {
    // Early return for falsy values
    if (!rawDate) {
      return null;
    }

    try {
      let momentDate;

      // Handle Date objects directly
      if (rawDate instanceof Date) {
        momentDate = this.moment(rawDate);
      }
      // Handle strings
      else if (typeof rawDate === 'string') {
        const trimmed = rawDate.trim();

        if (trimmed === '') {
          return null;
        }

        // Define all possible input formats
        const formats = [
          // Raw instrument formats (most specific first)
          'YYYYMMDDHHmmss',     // 20250110111212
          'YYYYMMDDHHmm',       // 202501101112
          'YYYYMMDD',           // 20250110

          // ISO and common formats
          'YYYY-MM-DD HH:mm:ss',
          'YYYY-MM-DDTHH:mm:ss',
          'YYYY-MM-DDTHH:mm:ssZ',
          'YYYY-MM-DD',

          // Other common formats
          'DD-MMM-YYYY HH:mm:ss',
          'DD/MM/YYYY HH:mm:ss',
          'MM/DD/YYYY HH:mm:ss',
        ];

        // Try strict parsing with known formats first
        momentDate = this.moment(trimmed, formats, true);

        // If strict parsing fails, try lenient parsing as fallback
        if (!momentDate.isValid()) {
          momentDate = this.moment(trimmed);
        }
      } else {
        // Unsupported type
        return null;
      }

      // Validate the parsed date
      if (!momentDate.isValid()) {
        this.logger('warn', `Invalid date - failed validation: ${rawDate}`, null);
        return null;
      }

      // Return in requested format
      return momentDate.format(outputFormat);
    } catch (error) {
      this.logger('error', `Error parsing date: ${rawDate} - ${error}`, null);
      return null;
    }
  }

  removeControlCharacters(astmData: string, withChecksum = true) {
    const controlCharMap = {
      '\x05': '',       // ENQ (Enquiry)
      '\x02': '',       // STX (Start of Text)
      '\x03': '<ETX>',  // ETX (End of Text)
      '\x04': '',       // EOT (End of Transmission)
      '\x17': '<ETB>',  // ETB (End of Transmission Block)
      '\n': '<CR>',     // Line Feed to <CR>
      '\r': '<CR>'      // Carriage Return to <CR>
    };

    // A record split across frames continues after <ETB>cc<CR><LF><STX>n
    // (GeneXpert fills 240-byte frames and cuts records wherever they fall).
    // Join the pieces before the frame number can leak into the record. The
    // checksum characters are optional so this also covers analyzers that
    // send none.
    astmData = astmData.replace(/\x17[0-9A-Fa-f]{0,2}\r?\n?\x02\d/g, '');

    // Replace control characters, but conditionally handle <ETB>
    astmData = astmData.replace(
      withChecksum ? /[\x05\x02\x03\x04\x17\n\r]/g : /[\x05\x02\x03\n\r]/g,
      match => controlCharMap[match]
    );

    // Replace consecutive <CR>
    astmData = astmData.replace(/(<CR>)+/g, '<CR>');

    // Conditionally remove checksums associated with <ETB> or <ETX>
    if (withChecksum) {
      // Match <ETB> or <ETX> followed by a 2-character checksum and optional <CR>
      astmData = astmData.replace(/<(ETB|ETX)>\w{2}(<CR>)?/g, '');
    }

    // Always remove remaining <ETX>
    astmData = astmData.replace(/<ETX>/g, ''); // Ensure <ETX> is removed completely

    return astmData;
  }


  fetchRecentResults(searchParam?: string): Observable<any[]> {
    const trimmedSearchParam = (searchParam || '').trim();
    return this.dbService.fetchRecentResults(trimmedSearchParam);
  }


  fetchrawData(searchParam: string = '') {
    const that = this;
    this.dbService.fetchrawData((res) => {
      res = [res];
      that.lastrawDataSubject.next(res);
    }, (err) => {
      that.logger('error', 'Failed to fetch raw data ' + JSON.stringify(err), null);
    }, searchParam)
  }


  fetchRecentLogs(instrumentId: string): Observable<any[]> {
    return this.dbService.fetchRecentLogs(instrumentId);
  }

  fetchRecentSystemLogs(): Observable<any[]> {
    return this.dbService.fetchRecentSystemLogs();
  }

  clearLiveLog(instrumentId = null) {
    if (instrumentId) {
      // Clear logs for a specific instrument
      const logSubject = this.getInstrumentLogSubject(instrumentId);
      logSubject.next([]);
    } else {
      // Clear logs for all instruments
      this.logTextMap.forEach((subject) => {
        subject.next([]);
      });
    }
  }

  reSyncRecord(orderId: string): Observable<any> {
    return of(this.dbService.reSyncRecord(orderId));
  }

  resyncIntelisStatusesToMySQL(success: any, errorf: any): void {
    this.dbService.resyncIntelisStatusesToMySQL(success, errorf);
  }

  fetchLastSyncTimes(): Observable<any> {
    return this.dbService.fetchLastSyncTimes();
  }

  getInstrumentLogSubject(instrumentId: string): BehaviorSubject<string[]> {
    if (!instrumentId) {
      instrumentId = 'general';
    }
    if (!this.logTextMap.has(instrumentId)) {
      this.logTextMap.set(instrumentId, new BehaviorSubject<string[]>([]));
    }
    return this.logTextMap.get(instrumentId);
  }
}
