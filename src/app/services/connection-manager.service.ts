// src/app/services/connection-manager.service.ts
import { Injectable, OnDestroy } from '@angular/core';
import { v4 as uuidv4 } from 'uuid';
import { InstrumentInterfaceService } from './instrument-interface.service';
import { ElectronStoreService } from './electron-store.service';
import { TcpConnectionService } from './tcp-connection.service';
import { BehaviorSubject, Observable, Subscription, timer } from 'rxjs';
import { ConnectionParams } from '../interfaces/connection-params.interface';
import { filter } from 'rxjs/operators';
import {
  AUTO_CONNECT,
  BACKGROUND_INTERVAL_MS,
  COMMUNICATION_PROTOCOL,
  CommunicationProtocol,
  CONNECTION_MODE
} from '../constants/domain.constants';

@Injectable({
  providedIn: 'root'
})
export class ConnectionManagerService implements OnDestroy {
  // Store the instruments and their connection status
  private activeInstruments: Map<string, any> = new Map();
  private commonSettings: any = null;
  private instrumentsSettings: any = null;
  private activeInstrumentsSubject = new BehaviorSubject<any[]>([]);
  private storeSubscription: Subscription;
  private statusSyncSubscription: Subscription;
  private readonly instrumentStatusSubscriptions = new Map<string, Subscription>();
  private readonly pendingInstrumentTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  constructor(
    private instrumentInterfaceService: InstrumentInterfaceService,
    private tcpService: TcpConnectionService,
    private store: ElectronStoreService
  ) {
    // Load the settings initially
    this.loadSettings();

    // Subscribe to store changes to update instruments if settings change
    this.storeSubscription = this.store.electronStoreObservable().subscribe(electronStoreObject => {
      if (!electronStoreObject) return;
      this.commonSettings = electronStoreObject.commonConfig;
      this.instrumentsSettings = electronStoreObject.instrumentsConfig;
      this.updateInstrumentsList();
    });

    this.startStatusSyncInterval();

  }

  private loadSettings() {
    const initialSettings = this.store.getAll();

    if (!initialSettings.commonConfig || !initialSettings.instrumentsConfig) {
      const initialCommonSettings = this.store.get('commonConfig');
      const initialInstrumentsSettings = this.store.get('instrumentsConfig');

      if (!initialCommonSettings || !initialInstrumentsSettings) {
        console.warn('Settings not found');
        return;
      }
    }

    this.commonSettings = initialSettings.commonConfig;
    this.instrumentsSettings = initialSettings.instrumentsConfig;
    this.updateInstrumentsList();
  }

  private updateInstrumentsList() {
    if (!this.instrumentsSettings) return;

    // Keep track of current instrument IDs to identify removed instruments
    const currentInstrumentIds = new Set(this.instrumentsSettings.map((i: any) => i.analyzerMachineName));

    // Find instruments that have been removed and disconnect them
    Array.from(this.activeInstruments.keys()).forEach(instrumentId => {
      if (!currentInstrumentIds.has(instrumentId)) {
        console.log(`Instrument removed from settings: ${instrumentId}`);
        const instrument = this.activeInstruments.get(instrumentId);
        if (instrument) {
          // Force disconnect if connected
          if (instrument.isConnected || instrument.connectionInProcess) {
            this.tcpService.disconnect(instrument.connectionParams);
          }
          this.clearInstrumentResources(instrumentId);
          this.activeInstruments.delete(instrumentId);
        }
      }
    });

    // Create or update instrument configurations
    this.instrumentsSettings.forEach((instrumentSetting: any, index: number) => {
      let instrumentId = instrumentSetting.analyzerMachineName;

      // Standardize protocol names
      const configuredProtocol = instrumentSetting.interfaceCommunicationProtocol as string;
      let protocol: CommunicationProtocol;
      if (configuredProtocol === 'astm-elecsys') {
        protocol = COMMUNICATION_PROTOCOL.ASTM_NON_CHECKSUM;
      } else if (configuredProtocol === 'astm-concatenated') {
        protocol = COMMUNICATION_PROTOCOL.ASTM_CHECKSUM;
      } else {
        protocol = configuredProtocol as CommunicationProtocol;
      }

      // Create connection parameters
      const connectionParams: ConnectionParams = {
        instrumentIndex: index,
        connectionMode: instrumentSetting.interfaceConnectionMode,
        connectionProtocol: protocol,
        host: instrumentSetting.analyzerMachineHost ?? '127.0.0.1',
        port: instrumentSetting.analyzerMachinePort,
        instrumentId: instrumentId,
        machineType: instrumentSetting.analyzerMachineType,
        labName: this.commonSettings.labName,
        displayorder: instrumentSetting.displayorder,
        interfaceAutoConnect: this.commonSettings ? this.commonSettings.interfaceAutoConnect : AUTO_CONNECT.ENABLED

      };

      // Check if instrument already exists in our active list
      let instrument = this.activeInstruments.get(instrumentId);
      let settingsChanged = false;

      if (instrument) {
        // Check if important connection settings have changed
        settingsChanged = this.haveConnectionSettingsChanged(instrument.connectionParams, connectionParams);

        // If connected and settings changed that affect the connection,
        // force disconnect before updating parameters
        if (settingsChanged && (instrument.isConnected || instrument.connectionInProcess)) {
          console.log(`Important settings changed for ${instrumentId}, disconnecting...`);
          this.tcpService.disconnect(instrument.connectionParams);

          // Reset state
          instrument.isConnected = false;
          instrument.connectionInProcess = false;
          instrument.transmissionInProgress = false;
        }

        // Update existing instrument's connection parameters
        instrument.connectionParams = { ...connectionParams };

        // Update the status text
        instrument.statusText = this.getStatusText(instrument);

        // If auto-connect is enabled and settings changed, reconnect after a delay
        if (settingsChanged && connectionParams.interfaceAutoConnect === AUTO_CONNECT.ENABLED) {
          this.scheduleInstrumentTask(instrumentId, () => {
            console.log(`Reconnecting ${instrumentId} after settings change`);
            this.reconnect(instrument);
          }, 2000); // Longer delay to ensure proper cleanup
        }
      } else {
        // Create a new instrument object
        instrument = {
          connectionParams: connectionParams,
          isConnected: false,
          connectionInProcess: false,
          transmissionInProgress: false,
          instrumentButtonText: connectionParams.connectionMode === CONNECTION_MODE.SERVER ? 'Start Server' : 'Connect',
          statusText: this.getStatusText({
            isConnected: false,
            connectionInProcess: false,
            transmissionInProgress: false,
            connectionParams: connectionParams
          })
        };

        this.activeInstruments.set(instrumentId, instrument);

        // If auto-connect is enabled, connect after a short delay
        if (connectionParams.interfaceAutoConnect === AUTO_CONNECT.ENABLED) {
          this.scheduleInstrumentTask(instrumentId, () => {
            this.reconnect(instrument);
          }, 1000);
        }
      }
    });

    // Update the behavior subject with the current list of instruments
    this.notifyInstrumentsChanged();
  }


  private haveConnectionSettingsChanged(oldParams: ConnectionParams, newParams: ConnectionParams): boolean {
    return (
      oldParams.host !== newParams.host ||
      oldParams.port !== newParams.port ||
      oldParams.connectionMode !== newParams.connectionMode ||
      oldParams.connectionProtocol !== newParams.connectionProtocol ||
      oldParams.machineType !== newParams.machineType
    );
  }

  private getStatusText(instrument: any): string {
    // First, check if the instrument is properly defined with all the properties we need
    if (!instrument || !instrument.connectionParams) {
      return 'Unknown Status';
    }

    // Check if transmitting - has highest priority
    if (instrument.transmissionInProgress) {
      return instrument.connectionParams.connectionMode === CONNECTION_MODE.SERVER
        ? 'Server Transmitting Data...'
        : 'Client Transmitting Data...';
    }

    // Check if connected - second highest priority
    // This is important - connected takes precedence over connectionInProcess
    if (instrument.isConnected) {
      return instrument.connectionParams.connectionMode === CONNECTION_MODE.SERVER
        ? 'Server Connected'
        : 'Client Connected';
    }

    // Check connection in process - lower priority than connected status
    if (instrument.connectionInProcess) {
      return instrument.connectionParams.connectionMode === CONNECTION_MODE.SERVER
        ? 'Server Listening...'
        : 'Client Connecting...';
    }

    // Default disconnected state
    return instrument.connectionParams.connectionMode === CONNECTION_MODE.SERVER
      ? 'Server Disconnected'
      : 'Client Disconnected';
  }

  private notifyInstrumentsChanged() {
    // Convert Map to Array for the BehaviorSubject
    const instrumentsArray = Array.from(this.activeInstruments.values());

    // Sort instruments by display order or name
    instrumentsArray.sort((a, b) => {
      if (a.connectionParams.displayorder != null && b.connectionParams.displayorder != null) {
        return a.connectionParams.displayorder - b.connectionParams.displayorder;
      } else if (a.connectionParams.displayorder == null && b.connectionParams.displayorder != null) {
        return 1;
      } else if (a.connectionParams.displayorder != null && b.connectionParams.displayorder == null) {
        return -1;
      } else {
        return a.connectionParams.instrumentId.localeCompare(b.connectionParams.instrumentId);
      }
    });

    this.activeInstrumentsSubject.next(instrumentsArray);
  }

  getActiveInstruments(): Observable<any[]> {
    return this.activeInstrumentsSubject.asObservable();
  }

  connect(instrument: any) {
    if (!instrument || !instrument.connectionParams) return;

    // Check if already connecting or connected
    const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
    if (instrumentFromMap && (instrumentFromMap.isConnected || instrumentFromMap.connectionInProcess)) {
      console.log(`Already connecting or connected to ${instrument.connectionParams.instrumentId}`);
      return;
    }

    // Generate a unique session ID
    const sessionId = this.generateUuid();
    const connectionMode = instrument.connectionParams.instrumentId;
    const startTime = this.getFormattedDateTime();

    // Store session data
    let storedData = JSON.parse(localStorage.getItem('sessionDatas') || '{}');
    if (!storedData[connectionMode]) {
      storedData[connectionMode] = [];
    }
    storedData[connectionMode].push({
      sessionId,
      startTime
    });
    localStorage.setItem('sessionDatas', JSON.stringify(storedData));

    // Update instrument state before connecting
    if (instrumentFromMap) {
      instrumentFromMap.connectionInProcess = true;
      const isTcpServer = instrumentFromMap.connectionParams.connectionMode === CONNECTION_MODE.SERVER;
      instrumentFromMap.instrumentButtonText = isTcpServer ? 'Waiting for client..' : 'Connecting...';
      instrumentFromMap.statusText = isTcpServer ? 'Server Listening...' : 'Client Connecting...';
      this.notifyInstrumentsChanged();
    }

    // Connect to the instrument
    console.log(`Connecting to ${instrument.connectionParams.instrumentId} (${instrument.connectionParams.host}:${instrument.connectionParams.port})`);
    this.instrumentInterfaceService.connect(instrument);
    this.updateInstrumentStatusSubscription(instrument);
  }

  reconnect(instrument: any) {
    if (!instrument || !instrument.connectionParams) return;

    const connectionMode = instrument.connectionParams.instrumentId;

    // Ensure we're disconnected first
    this.tcpService.disconnect(instrument.connectionParams);

    // Add a longer delay to allow the OS to fully release the port
    const portReleaseDelay = 3000; // 3 seconds should be enough for most OSes

    // Update instrument state to show connecting status
    const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
    if (instrumentFromMap) {
      instrumentFromMap.connectionInProcess = true;
      instrumentFromMap.instrumentButtonText = 'Waiting for port...';
      instrumentFromMap.statusText = `Waiting for port ${instrument.connectionParams.port} to be released...`;
      this.notifyInstrumentsChanged();
    }

    // Update session data
    let sessionData = JSON.parse(localStorage.getItem('sessionDatas') || '{}');
    if (!sessionData[connectionMode]) {
      sessionData[connectionMode] = {
        sessionId: this.generateUuid(),
        startTime: this.getFormattedDateTime()
      };
    } else {
      sessionData[connectionMode].startTime = this.getFormattedDateTime();
    }
    localStorage.setItem('sessionDatas', JSON.stringify(sessionData));

    console.log(`Waiting ${portReleaseDelay}ms for port release before reconnecting ${instrument.connectionParams.instrumentId}`);

    // Wait for port to be released
    this.scheduleInstrumentTask(instrument.connectionParams.instrumentId, () => {
      if (instrumentFromMap) {
        const isTcpServer = instrumentFromMap.connectionParams.connectionMode === CONNECTION_MODE.SERVER;
        instrumentFromMap.instrumentButtonText = isTcpServer ? 'Waiting for client...' : 'Connecting...';
        instrumentFromMap.statusText = isTcpServer ? 'Server Listening...' : 'Client Connecting...';
        this.notifyInstrumentsChanged();
      }

      // Reconnect the instrument
      console.log(`Reconnecting ${instrument.connectionParams.instrumentId} after port release delay`);
      this.instrumentInterfaceService.reconnect(instrument);
      this.updateInstrumentStatusSubscription(instrument);
    }, portReleaseDelay);
  }

  disconnect(instrument: any) {
    if (!instrument || !instrument.connectionParams) return;

    const connectionMode = instrument.connectionParams.instrumentId;
    this.clearInstrumentTimers(connectionMode);

    // Update session data with disconnect time
    const sessionData = JSON.parse(localStorage.getItem('sessionDatas') || '{}');
    if (sessionData[connectionMode]) {
      sessionData[connectionMode].endTime = this.getFormattedDateTime();
      localStorage.setItem('sessionDatas', JSON.stringify(sessionData));
    }

    // Disconnect the instrument
    this.instrumentInterfaceService.disconnect(instrument);
  }

  sendASTMOrders(instrument: any) {
    if (!instrument || !instrument.connectionParams) return;
    this.instrumentInterfaceService.fetchAndSendASTMOrders(instrument);
  }



  private updateInstrumentStatusSubscription(instrument: any) {
    const instrumentId = instrument.connectionParams.instrumentId;
    const subscriptions = new Subscription();

    // WHY: reconnects reuse the same subjects. Keeping old subscribers would
    // multiply UI updates and retain component state for the lifetime of the app.
    this.instrumentStatusSubscriptions.get(instrumentId)?.unsubscribe();
    this.instrumentStatusSubscriptions.set(instrumentId, subscriptions);

    // Subscribe to connection status changes
    const statusObservable = this.tcpService.getStatusObservable(instrument.connectionParams);
    if (statusObservable) {
      subscriptions.add(statusObservable.subscribe(status => {
        const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
        if (instrumentFromMap) {
          //console.log(`Status update for ${instrumentFromMap.connectionParams.instrumentId}: isConnected=${status}`);
          // If the status is changing from connected to disconnected
          if (instrumentFromMap.isConnected && !status) {
            console.log(`Instrument ${instrumentFromMap.connectionParams.instrumentId} has disconnected`);

            // Update the last disconnect time for reporting
            instrumentFromMap.lastDisconnectTime = this.getFormattedDateTime();

            // Also update the session data
            const connectionMode = instrument.connectionParams.instrumentId;
            const sessionData = JSON.parse(localStorage.getItem('sessionDatas') || '{}');
            if (sessionData[connectionMode]) {
              sessionData[connectionMode].endTime = this.getFormattedDateTime();
              localStorage.setItem('sessionDatas', JSON.stringify(sessionData));
            }
          }

          instrumentFromMap.isConnected = status;

          // When connection status changes, we should override any other status indicators
          // except for transmission in progress
          if (!instrumentFromMap.transmissionInProgress) {
            instrumentFromMap.statusText = this.getStatusText(instrumentFromMap);
          }

          // If we're now connected, we're no longer in the connection process
          if (status === true) {
            instrumentFromMap.connectionInProcess = false;
          }

          this.notifyInstrumentsChanged();
        }
      }));
    }

    // Subscribe to connection attempt status
    const attemptObservable = this.tcpService.getConnectionAttemptObservable(instrument.connectionParams);
    if (attemptObservable) {
      subscriptions.add(attemptObservable.subscribe(status => {
        const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
        if (instrumentFromMap) {
          console.log(`Connection attempt update for ${instrumentFromMap.connectionParams.instrumentId}: inProcess=${status}`);

          const isTcpServer = instrumentFromMap.connectionParams.connectionMode === CONNECTION_MODE.SERVER;

          // Only update connection process status if we're not already connected
          // This prevents "Listening" status when already connected
          if (!instrumentFromMap.isConnected) {
            instrumentFromMap.connectionInProcess = status;
            instrumentFromMap.instrumentButtonText = status
              ? 'Connecting...'
              : (isTcpServer ? 'Start Server' : 'Connect');

            // Only update the status text if we're not in the middle of a transmission
            if (!instrumentFromMap.transmissionInProgress) {
              instrumentFromMap.statusText = this.getStatusText(instrumentFromMap);
            }
          }

          this.notifyInstrumentsChanged();
        }
      }));
    }

    // Subscribe to transmission status
    const transmissionObservable = this.tcpService.getTransmissionStatusObservable(instrument.connectionParams);
    if (transmissionObservable) {
      subscriptions.add(transmissionObservable.subscribe(status => {
        const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
        if (instrumentFromMap) {
          console.log(`Transmission update for ${instrumentFromMap.connectionParams.instrumentId}: transmitting=${status}`);

          instrumentFromMap.transmissionInProgress = status;

          // Update status text to reflect transmission
          if (status) {
            // If transmitting data, show a special status
            instrumentFromMap.statusText = instrumentFromMap.connectionParams.connectionMode === CONNECTION_MODE.SERVER
              ? 'Server Transmitting Data...'
              : 'Client Transmitting Data...';
          } else {
            // When transmission is done, revert to normal status based on connection state
            instrumentFromMap.statusText = this.getStatusText(instrumentFromMap);
          }

          this.notifyInstrumentsChanged();
        }
      }));
    }
  }

  private generateUuid(): string {
    return uuidv4();
  }

  private getFormattedDateTime(): string {
    const now = new Date();
    const year = String(now.getFullYear()).padStart(4, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  // Add this method to src/app/services/connection-manager.service.ts

  cancelConnection(instrument: any) {
    if (!instrument || !instrument.connectionParams) return;

    console.log(`Cancelling connection attempt for ${instrument.connectionParams.instrumentId}`);
    this.clearInstrumentTimers(instrument.connectionParams.instrumentId);

    // First, update the instrument status
    const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
    if (instrumentFromMap) {
      // Update status indicators
      instrumentFromMap.connectionInProcess = false;
      instrumentFromMap.isConnected = false;
      instrumentFromMap.transmissionInProgress = false;

      // Update UI elements
      const isTcpServer = instrumentFromMap.connectionParams.connectionMode === CONNECTION_MODE.SERVER;
      instrumentFromMap.instrumentButtonText = isTcpServer ? 'Start Server' : 'Connect';
      instrumentFromMap.statusText = isTcpServer ? 'Server Disconnected' : 'Client Disconnected';

      // Notify subscribers about the changes
      this.notifyInstrumentsChanged();
    }

    // Disconnect from TcpConnectionService to ensure resources are properly cleaned up
    this.tcpService.disconnect(instrument.connectionParams);
  }


  forceRestartConnection(instrument: any) {
    if (!instrument || !instrument.connectionParams) return;

    console.log(`Force restarting connection for ${instrument.connectionParams.instrumentId}`);

    // First, ensure we're disconnected
    this.tcpService.disconnect(instrument.connectionParams);

    // Update instrument state immediately to show we're resetting
    const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
    if (instrumentFromMap) {
      instrumentFromMap.isConnected = false;
      instrumentFromMap.connectionInProcess = false;
      instrumentFromMap.transmissionInProgress = false;

      const isTcpServer = instrumentFromMap.connectionParams.connectionMode === CONNECTION_MODE.SERVER;
      instrumentFromMap.instrumentButtonText = isTcpServer ? 'Start Server' : 'Connect';
      instrumentFromMap.statusText = isTcpServer ? 'Server Disconnected' : 'Client Disconnected';
      this.notifyInstrumentsChanged();
    }

    // Use a Node.js child process to forcefully kill any process using the port
    // This is Electron-specific and uses the 'child_process' module
    // You'll need to implement this through your ElectronService or similar service

    // After force killing, add a delay then reconnect
    this.scheduleInstrumentTask(instrument.connectionParams.instrumentId, () => {
      this.reconnect(instrument);
    }, 5000); // 5 seconds to allow port to be fully released
  }

  reconnectAllAutoConnectInstruments() {
    console.log('Reconnecting all instruments with auto-connect enabled');

    // Get all instruments with auto-connect enabled
    const autoConnectInstruments = Array.from(this.activeInstruments.values())
      .filter(instrument => {
        // Log the auto-connect check for debugging
        console.log(`Checking instrument ${instrument.connectionParams.instrumentId}:`, {
          autoConnect: instrument.connectionParams.interfaceAutoConnect,
          isConnected: instrument.isConnected,
          inProcess: instrument.connectionInProcess
        });

        return instrument.connectionParams.interfaceAutoConnect === AUTO_CONNECT.ENABLED &&
          !instrument.isConnected &&
          !instrument.connectionInProcess;
      });

    console.log(`Found ${autoConnectInstruments.length} instruments to auto-connect`);

    // Reconnect each instrument with a staggered delay
    autoConnectInstruments.forEach((instrument, index) => {
      const delay = 2000 + (1000 * index); // Start with 2 seconds, then add 1 second per instrument
      console.log(`Will auto-reconnect ${instrument.connectionParams.instrumentId} after ${delay}ms`);

      this.scheduleInstrumentTask(instrument.connectionParams.instrumentId, () => {
        console.log(`Now auto-reconnecting ${instrument.connectionParams.instrumentId}`);
        this.reconnect(instrument);
      }, delay);
    });

    return autoConnectInstruments.length; // Return number of instruments reconnected
  }

  refreshConnectionStatus(instrument: any) {
    if (!instrument || !instrument.connectionParams) return;

    //console.log(`Refreshing connection status for ${instrument.connectionParams.instrumentId}`);

    // Check actual connection status from TcpConnectionService
    const actual = this.tcpService.isActuallyConnected(instrument.connectionParams);

    // Update local status
    const instrumentFromMap = this.activeInstruments.get(instrument.connectionParams.instrumentId);
    if (instrumentFromMap && instrumentFromMap.isConnected !== actual) {
      //console.log(`Syncing status for ${instrument.connectionParams.instrumentId}: UI=${instrumentFromMap.isConnected}, Actual=${actual}`);
      instrumentFromMap.isConnected = actual;
      instrumentFromMap.statusText = this.getStatusText(instrumentFromMap);
      this.notifyInstrumentsChanged();
    }
  }

  // Add a periodic status check
  startStatusSyncInterval() {
    this.statusSyncSubscription = timer(0, BACKGROUND_INTERVAL_MS.CONNECTION_STATUS).pipe(
      // Only run when document is visible
      filter(() => document.visibilityState === 'visible')
    ).subscribe(() => {
      Array.from(this.activeInstruments.values()).forEach(instrument => {
        this.refreshConnectionStatus(instrument);
      });
    });
  }

  ngOnDestroy() {
    this.storeSubscription?.unsubscribe();
    this.statusSyncSubscription?.unsubscribe();
    this.instrumentStatusSubscriptions.forEach(subscription => subscription.unsubscribe());
    this.instrumentStatusSubscriptions.clear();
    this.pendingInstrumentTimers.forEach(timers => {
      timers.forEach(timeout => clearTimeout(timeout));
    });
    this.pendingInstrumentTimers.clear();
    this.activeInstrumentsSubject.complete();
  }

  private scheduleInstrumentTask(instrumentId: string, task: () => void, delay: number): void {
    const timers = this.pendingInstrumentTimers.get(instrumentId) ?? new Set();
    const timeout = setTimeout(() => {
      timers.delete(timeout);
      if (timers.size === 0) {
        this.pendingInstrumentTimers.delete(instrumentId);
      }
      task();
    }, delay);

    timers.add(timeout);
    this.pendingInstrumentTimers.set(instrumentId, timers);
  }

  private clearInstrumentTimers(instrumentId: string): void {
    const timers = this.pendingInstrumentTimers.get(instrumentId);
    timers?.forEach(timeout => clearTimeout(timeout));
    this.pendingInstrumentTimers.delete(instrumentId);
  }

  private clearInstrumentResources(instrumentId: string): void {
    this.clearInstrumentTimers(instrumentId);
    this.instrumentStatusSubscriptions.get(instrumentId)?.unsubscribe();
    this.instrumentStatusSubscriptions.delete(instrumentId);
  }
}
