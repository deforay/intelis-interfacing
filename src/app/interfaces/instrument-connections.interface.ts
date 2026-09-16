// src/app/interfaces/instrument-connections.interface.ts

import { BehaviorSubject } from 'rxjs';
import { CommunicationProtocol, ConnectionMode } from '../constants/domain.constants';

export interface InstrumentConnectionStack {
  connectionMode?: ConnectionMode;
  connectionProtocol?: CommunicationProtocol;
  instrumentId?: string;
  labName?: string;
  machineType?: string;
  /**
   * The instrument's result rules, when the caller has already resolved its
   * settings (reprocessing). Otherwise they are read by instrument name.
   */
  resultRules?: unknown;
  statusSubject: BehaviorSubject<boolean>;
  connectionAttemptStatusSubject: BehaviorSubject<boolean>;
  transmissionStatusSubject: BehaviorSubject<boolean>;
  connectionSocket?: any;
  connectionServer?: any;
  errorOccurred: boolean;
  reconnectAttempts: number;
  pendingReconnectTimer?: any;
}
