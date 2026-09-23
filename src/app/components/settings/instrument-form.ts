import { FormBuilder, FormGroup } from '@angular/forms';
import { effectiveResultRules, normalizeResultRules } from '../../../../shared/result-rules';
import { COMMUNICATION_PROTOCOL, CommunicationProtocol } from '../../constants/domain.constants';

/**
 * The protocol each analyzer type is known to send, from the captures its
 * parser is tested against. A protocol set wrongly stores nothing, or junk,
 * from every result, so choosing the type chooses this protocol; it can still
 * be changed. Types missing here have no single protocol to assume: TaqMan
 * framing is not confirmed from a capture.
 */
export const RECOMMENDED_PROTOCOL: Readonly<Record<string, CommunicationProtocol>> = {
  'cepheid-genexpert': COMMUNICATION_PROTOCOL.ASTM_CHECKSUM,
  'abbott-m2000': COMMUNICATION_PROTOCOL.ASTM_CHECKSUM,
  'abbott-alinity-m': COMMUNICATION_PROTOCOL.HL7,
  'roche-cobas-4800': COMMUNICATION_PROTOCOL.HL7,
  'roche-cobas-5800': COMMUNICATION_PROTOCOL.HL7,
  'roche-cobas-6800': COMMUNICATION_PROTOCOL.HL7,
  'other-astm-checksum': COMMUNICATION_PROTOCOL.ASTM_CHECKSUM,
  'other-astm-nonchecksum': COMMUNICATION_PROTOCOL.ASTM_NON_CHECKSUM,
  'other-hl7': COMMUNICATION_PROTOCOL.HL7
};

const PROTOCOL_LABELS: Readonly<Record<CommunicationProtocol, string>> = {
  [COMMUNICATION_PROTOCOL.ASTM_CHECKSUM]: 'ASTM (with checksum)',
  [COMMUNICATION_PROTOCOL.ASTM_NON_CHECKSUM]: 'ASTM (without checksum)',
  [COMMUNICATION_PROTOCOL.HL7]: 'HL7'
};

/**
 * Sets the protocol an analyzer type is known to send. Called when someone
 * picks the type, never when saved settings are loaded, so an instrument that
 * was deliberately set otherwise is left as it is.
 */
export function applyRecommendedProtocol(instrument: FormGroup): void {
  const recommended = RECOMMENDED_PROTOCOL[instrument.get('analyzerMachineType')?.value];
  if (recommended) {
    instrument.get('interfaceCommunicationProtocol')?.setValue(recommended);
  }
}

/**
 * A warning when the protocol is not the one the analyzer type is known to
 * send, or null.
 */
export function protocolMismatchWarning(machineType: string, protocol: string): string | null {
  const recommended = RECOMMENDED_PROTOCOL[machineType];
  if (!recommended || !protocol || protocol === recommended) {
    return null;
  }
  return `This analyzer normally sends ${PROTOCOL_LABELS[recommended]}. Use the same protocol here as on the instrument, or its results will not be read.`;
}

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
