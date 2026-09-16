import { FormBuilder } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { LEGACY_HL7_RESULT_RULES } from '../../../../shared/result-rules';
import { instrumentForSave, savedInstrumentFormGroup } from './instrument-form';

describe('instrument settings form and result rules', () => {
  const formBuilder = new FormBuilder();
  const hl7Instrument = {
    analyzerMachineName: 'COBAS-1',
    analyzerMachineType: 'roche-cobas-4800',
    interfaceCommunicationProtocol: 'hl7',
    analyzerMachineHost: '10.0.0.5',
    analyzerMachinePort: '5001',
    interfaceConnectionMode: 'tcpserver',
    displayorder: '1'
  };

  it('shows an HL7 instrument saved before rules existed with the rules it is read with, and saves them', () => {
    const group = savedInstrumentFormGroup(formBuilder, hl7Instrument);

    expect(group.get('resultRules')?.value).toEqual([...LEGACY_HL7_RESULT_RULES]);
    expect(instrumentForSave(group.value).resultRules).toEqual([...LEGACY_HL7_RESULT_RULES]);
  });

  it('keeps saved rules, including none, through the form and back', () => {
    const rules = [
      { match: 'contains', value: 'not detected', replaceWith: 'Target Not Detected', ignoreCase: true },
      { match: 'exact', value: 'Invalid', replaceWith: 'Failed' }
    ];
    for (const saved of [rules, []]) {
      const group = savedInstrumentFormGroup(formBuilder, { ...hl7Instrument, resultRules: saved });
      expect(instrumentForSave(group.value).resultRules).toEqual(saved);
    }
  });

  it('saves an instrument without rules as having none, and drops incomplete rules', () => {
    const saved = instrumentForSave({
      analyzerMachineName: 'NEW',
      resultRules: [
        { match: 'exact', value: '<20', replaceWith: '' },
        { match: 'exact', value: '', replaceWith: 'X' },
        { match: 'exact', value: 'ERROR', replaceWith: 'Failed' }
      ]
    });

    expect(saved.resultRules).toEqual([{ match: 'exact', value: 'ERROR', replaceWith: 'Failed' }]);
    expect(instrumentForSave({ analyzerMachineName: 'NEW' }).resultRules).toEqual([]);
  });
});
