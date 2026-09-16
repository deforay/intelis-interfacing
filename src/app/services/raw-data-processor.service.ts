import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronStoreService } from './electron-store.service';
import { UtilitiesService } from './utilities.service';
import { InstrumentInterfaceService } from './instrument-interface.service';
import { InstrumentConnectionStack } from '../interfaces/instrument-connections.interface';

@Injectable({
  providedIn: 'root'
})
export class RawDataProcessorService {
  private static readonly PERSISTENCE_TIMEOUT_MS = 60_000;
  private reprocessingStatus = new BehaviorSubject<any>({
    inProgress: false,
    processedCount: 0,
    totalCount: 0,
    currentItem: '',
    success: 0,
    failed: 0,
    errors: []
  });

  private instrumentsSettings: any = null;
  private commonSettings: any = null;

  constructor(
    private utilsService: UtilitiesService,
    private readonly electronStoreService: ElectronStoreService,
    private instrumentInterfaceService: InstrumentInterfaceService
  ) {
    this.commonSettings = this.electronStoreService.get('commonConfig');
    this.instrumentsSettings = this.electronStoreService.get('instrumentsConfig');
    console.log('Instrument settings loaded:', this.instrumentsSettings);
  }

  getReprocessingStatus(): Observable<any> {
    return this.reprocessingStatus.asObservable();
  }

  async reprocessRawData(rawDataEntries: any[]): Promise<any> {
    if (!rawDataEntries || rawDataEntries.length === 0) {
      return { success: 0, failed: 0 };
    }

    this.reprocessingStatus.next({
      inProgress: true,
      processedCount: 0,
      totalCount: rawDataEntries.length,
      currentItem: 'Starting reprocessing...',
      success: 0,
      failed: 0,
      errors: []
    });

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    for (let i = 0; i < rawDataEntries.length; i++) {
      const entry = rawDataEntries[i];

      try {
        this.reprocessingStatus.next({
          inProgress: true,
          processedCount: i,
          totalCount: rawDataEntries.length,
          currentItem: `Processing entry ${i + 1}/${rawDataEntries.length} (${entry.instrument_id || entry.machine})`,
          success: successCount,
          failed: failedCount,
          errors: errors
        });

        const instrumentId = entry.instrument_id || entry.machine;
        const instrumentSettings = this.getInstrumentSettings(instrumentId);

        if (!instrumentSettings) {
          throw new Error(`No settings found for instrument: ${instrumentId}`);
        }

        const success = await this.reprocessUsingInstrumentInterface(entry, instrumentSettings);

        if (success) {
          successCount++;
        } else {
          failedCount++;
          errors.push(`Failed to reprocess raw data ID: ${entry.id}`);
        }
      } catch (error) {
        failedCount++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Error processing entry ${i + 1}: ${errorMessage}`);
      }

      this.reprocessingStatus.next({
        inProgress: true,
        processedCount: i + 1,
        totalCount: rawDataEntries.length,
        currentItem: i < rawDataEntries.length - 1 ?
          `Processed ${i + 1}/${rawDataEntries.length}` :
          'Completing reprocessing...',
        success: successCount,
        failed: failedCount,
        errors: errors
      });
    }

    const finalStatus = {
      inProgress: false,
      processedCount: rawDataEntries.length,
      totalCount: rawDataEntries.length,
      currentItem: 'Reprocessing complete',
      success: successCount,
      failed: failedCount,
      errors: errors
    };
    this.reprocessingStatus.next(finalStatus);

    return { success: successCount, failed: failedCount };
  }

  private getInstrumentSettings(analyzerMachineName: string): any {
    if (!Array.isArray(this.instrumentsSettings) || !analyzerMachineName) {
      return null;
    }

    const instrumentSettings = this.instrumentsSettings.find(
      (inst: any) =>
        inst.analyzerMachineName &&
        inst.analyzerMachineName.toLowerCase() === analyzerMachineName.toLowerCase()
    );

    if (instrumentSettings) {
      return instrumentSettings;
    }

    const flexMatch = this.instrumentsSettings.find(
      (inst: any) =>
        inst.analyzerMachineName &&
        (inst.analyzerMachineName.toLowerCase().includes(analyzerMachineName.toLowerCase()) ||
          analyzerMachineName.toLowerCase().includes(inst.analyzerMachineName.toLowerCase()))
    );

    if (flexMatch) {
      this.utilsService.logger('info', `Flexible match found for ${analyzerMachineName}`, analyzerMachineName);
      return flexMatch;
    }

    return null;
  }

  private async reprocessUsingInstrumentInterface(entry: any, instrumentSettings: any): Promise<boolean> {
    try {
      const rawData = entry.data;
      const machineType = instrumentSettings.analyzerMachineType;
      const protocol = instrumentSettings.interfaceCommunicationProtocol;

      const instrumentConnectionData: InstrumentConnectionStack = {
        instrumentId: instrumentSettings.analyzerMachineName,
        machineType: machineType,
        connectionProtocol: protocol,
        labName: instrumentSettings.labName || 'Default Lab',
        transmissionStatusSubject: new BehaviorSubject<boolean>(false),
        statusSubject: new BehaviorSubject<boolean>(true),
        connectionAttemptStatusSubject: new BehaviorSubject<boolean>(true),
        connectionSocket: null,
        connectionServer: null,
        errorOccurred: false,
        reconnectAttempts: 0
      };


      let persistenceResults: boolean[] = [];
      if (protocol === 'hl7') {
        // Raw data keeps the MLLP block exactly as it arrived. Unwrap it the
        // way live processing does, or framing bytes end up in the stored
        // records and line breaks are split differently.
        const hl7Message = this.instrumentInterfaceService['hl7Helper'].unwrapMLLPBlock(rawData);
        let persistencePromise: Promise<boolean[]>;
        if (machineType === 'abbott-alinity-m') {
          persistencePromise = this.instrumentInterfaceService.processHL7DataAlinity(instrumentConnectionData, hl7Message);
        } else if (machineType === 'roche-cobas-5800') {
          persistencePromise = this.instrumentInterfaceService.processHL7DataRoche5800(instrumentConnectionData, hl7Message);
        } else if (machineType === 'roche-cobas-6800' || machineType === 'roche-cobas-8800') {
          persistencePromise = this.instrumentInterfaceService.processHL7DataRoche68008800(instrumentConnectionData, hl7Message);
        } else {
          persistencePromise = this.instrumentInterfaceService.processHL7Data(instrumentConnectionData, hl7Message);
        }
        persistenceResults = await this.withPersistenceTimeout(persistencePromise);
      } else if (protocol === 'astm-checksum' || protocol === 'astm-nonchecksum') {
        const astmData = this.utilsService.removeControlCharacters(rawData, protocol !== 'astm-nonchecksum');
        const parts = astmData.split(this.instrumentInterfaceService['astmHelper'].getStartMarker());
        const persistencePromises: Promise<boolean>[] = [];

        const astmHelper = this.instrumentInterfaceService['astmHelper'];
        for (const part of parts) {
          if (!part) continue;
          const astmArray = part.split(/<CR>/);

          for (const group of astmHelper.splitASTMRecordsByOrder(astmArray)) {
            const dataBlock = astmHelper.getASTMDataBlock(group);
            if (Object.keys(dataBlock).length > 0) {
              persistencePromises.push(
                this.instrumentInterfaceService.processStoredASTMDataBlock(dataBlock, part, instrumentConnectionData)
              );
            }
          }
        }
        persistenceResults = await this.withPersistenceTimeout(Promise.all(persistencePromises));
      } else {
        throw new Error(`Unsupported protocol: ${protocol}`);
      }

      return persistenceResults.length > 0 && persistenceResults.every(Boolean);
    } catch (error) {
      this.utilsService.logger('error', `InstrumentInterface reprocessing error: ${error}`, entry.instrument_id || entry.machine);
      return false;
    }
  }

  private withPersistenceTimeout(persistence: Promise<boolean[]>): Promise<boolean[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for reprocessed results to be saved'));
      }, RawDataProcessorService.PERSISTENCE_TIMEOUT_MS);

      persistence.then(resolve, reject).finally(() => clearTimeout(timeout));
    });
  }
}
