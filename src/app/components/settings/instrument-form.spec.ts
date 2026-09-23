import { FormBuilder } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { LEGACY_HL7_RESULT_RULES } from '../../../../shared/result-rules';
import { applyRecommendedProtocol, instrumentForSave, protocolMismatchWarning, savedInstrumentFormGroup } from './instrument-form';

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

describe('protocol chosen with the analyzer type', () => {
  const formBuilder = new FormBuilder();
  const instrument = (analyzerMachineType: string, interfaceCommunicationProtocol = '') =>
    formBuilder.group({ analyzerMachineType, interfaceCommunicationProtocol });

  it('sets the protocol each known analyzer type sends', () => {
    for (const [machineType, protocol] of [
      ['cepheid-genexpert', 'astm-checksum'],
      ['abbott-m2000', 'astm-checksum'],
      ['abbott-alinity-m', 'hl7'],
      ['roche-cobas-5800', 'hl7'],
      ['other-astm-nonchecksum', 'astm-nonchecksum']
    ]) {
      const group = instrument(machineType, 'hl7' === protocol ? 'astm-checksum' : 'hl7');
      applyRecommendedProtocol(group);
      expect(group.get('interfaceCommunicationProtocol')?.value, machineType).toBe(protocol);
    }
  });

  it('leaves the protocol alone for a type without a known protocol', () => {
    const group = instrument('roche-cobas-taqman', 'astm-nonchecksum');
    applyRecommendedProtocol(group);
    expect(group.get('interfaceCommunicationProtocol')?.value).toBe('astm-nonchecksum');
  });

  it('does not change a saved instrument when settings are loaded', () => {
    const group = savedInstrumentFormGroup(formBuilder, { analyzerMachineType: 'cepheid-genexpert', interfaceCommunicationProtocol: 'astm-nonchecksum' });
    expect(group.get('interfaceCommunicationProtocol')?.value).toBe('astm-nonchecksum');
  });

  it('warns only when the protocol differs from the one the type is known to send', () => {
    expect(protocolMismatchWarning('cepheid-genexpert', 'hl7')).toContain('ASTM (with checksum)');
    expect(protocolMismatchWarning('cepheid-genexpert', 'astm-checksum')).toBeNull();
    expect(protocolMismatchWarning('roche-cobas-taqman', 'hl7')).toBeNull();
    expect(protocolMismatchWarning('cepheid-genexpert', '')).toBeNull();
  });
});
