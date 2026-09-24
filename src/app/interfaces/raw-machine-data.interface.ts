// src/app/interfaces/raw-machine-data.interface.ts

export interface RawMachineData {
  data: string;
  machine: string;
  instrument_id?: string;
  /**
   * Identifies the transmission; its results carry it. The same in SQLite and
   * MySQL for a transmission stored with it. One stored earlier and already
   * copied to MySQL is given one in each database separately.
   */
  transmission_id?: string;
  /** SHA-256 of data, filled in when the transmission is stored */
  sha256?: string;
}

/** Which stored raw data to list or reprocess. */
export interface RawDataFilter {
  instrumentId?: string;
  /** First day, YYYY-MM-DD, as the received time is shown */
  from?: string;
  /** Last day, YYYY-MM-DD, included */
  to?: string;
  /** Text anywhere in the instrument name, received time or data */
  search?: string;
}

/** The database raw data is read from: MySQL when connected, else SQLite. */
export type RawDataStore = 'mysql' | 'sqlite';
