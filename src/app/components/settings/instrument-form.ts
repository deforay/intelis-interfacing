import { FormBuilder, FormGroup } from '@angular/forms';
import { effectiveResultRules, normalizeResultRules } from '../../../../shared/result-rules';

/**
 * The form group for a saved instrument. Its result rules are wrapped, since
 * FormBuilder reads a bare array as [value, validators], and an instrument
 * saved before rules existed shows the rules it is read with, so saving the
 * form keeps them.
 */
export function savedInstrumentFormGroup(formBuilder: FormBuilder, instrument: Record<string, any>): FormGroup {
  return formBuilder.group({
    ...instrument,
    resultRules: [effectiveResultRules(instrument)]
  });
}

/** An instrument as it is written to settings: every field present, only complete rules. */
export function instrumentForSave(instrument: Record<string, any>): Record<string, any> {
  const defaultInstrument = {
    analyzerMachineType: '',
    interfaceCommunicationProtocol: '',
    analyzerMachineName: '',
    analyzerMachineHost: '',
    analyzerMachinePort: '',
    interfaceConnectionMode: '',
    displayorder: '',
    resultRules: []
  };
  return { ...defaultInstrument, ...instrument, resultRules: normalizeResultRules(instrument.resultRules) };
}
