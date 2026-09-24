import { HL7HelperService } from './hl7-helper.service';
import { beforeEach, describe, expect, it } from 'vitest';

describe('HL7HelperService', () => {
  let service: HL7HelperService;

  const utilitiesServiceStub = {
    decodeHtmlEntities: (text: string) => text
  };

  const createObxSegment = (fields: Record<string, string>) => ({
    get: (path: string) => {
      if (!(path in fields)) {
        return null;
      }
      return {
        toString: () => fields[path]
      };
    }
  });

  beforeEach(() => {
    service = new HL7HelperService(utilitiesServiceStub as any);
  });

  describe('choosing a specimen\'s result OBX when no other rule applies', () => {
    const runTime = (setId: string) => createObxSegment({ 'OBX.2': 'DR', 'OBX.3.1': 'RunTimeRange', 'OBX.4': setId, 'OBX.5.1': '20260612163740' });
    const glucose = (setId: string, value: string) => createObxSegment({ 'OBX.2': 'NM', 'OBX.3.1': 'GLUCOSE', 'OBX.4': setId, 'OBX.5.1': value });

    it('gives each specimen of a shared results section its own result', () => {
      const shared = [runTime('1.0'), glucose('1.1', '10'), runTime('2.0'), glucose('2.1', '20')];

      expect(service.findAppropriateHL7OBXSegment(shared, 1).get('OBX.5.1').toString()).toBe('10');
      expect(service.findAppropriateHL7OBXSegment(shared, 2).get('OBX.5.1').toString()).toBe('20');
    });

    it('finds no result in a specimen with only a run-time range', () => {
      expect(service.findAppropriateHL7OBXSegment([runTime('1.0')], 1)).toBeNull();
      expect(service.findAppropriateHL7OBXSegment([runTime('1.0')], 3)).toBeNull();
    });
  });

  it('maps Roche BT OBX-8 flag to Target Not Detected when OBX-5 is empty', () => {
    const obx = createObxSegment({
      'OBX.5.1': '',
      'OBX.8': 'BT^^99ROC',
      'OBX.11': 'F'
    });

    const result = service.processHL7ResultValue(obx, service.getHL7ResultStatusType(obx));

    expect(result.results).toBe('Target Not Detected');
    expect(result.test_unit).toBe('');
    expect(result.notes).toBe('');
  });

  it('maps Roche ND OBX-8 flag to Target Not Detected when OBX-5 is empty', () => {
    const obx = createObxSegment({
      'OBX.5.1': '',
      'OBX.8': 'ND^^99ROC',
      'OBX.11': 'F'
    });

    const result = service.processHL7ResultValue(obx, service.getHL7ResultStatusType(obx));

    expect(result.results).toBe('Target Not Detected');
    expect(result.test_unit).toBe('');
    expect(result.notes).toBe('');
  });

  it('treats Roche Uxx flags in OBX-8 as ERROR status', () => {
    const obx = createObxSegment({
      'OBX.5.1': '',
      'OBX.8.1': 'U06T',
      'OBX.11': 'F'
    });

    expect(service.getHL7ResultStatusType(obx)).toBe('ERROR');
  });

  it('preserves OBX-8 text for ERROR when no OBX-5 value exists', () => {
    const obx = createObxSegment({
      'OBX.5.1': '',
      'OBX.8': 'U06T^Pipetting anomaly detected during sample aspiration.^99ROC',
      'OBX.8.1': 'U06T',
      'OBX.11': 'F'
    });

    const result = service.processHL7ResultValue(obx, service.getHL7ResultStatusType(obx));

    expect(result.results).toBe('Failed');
    expect(result.test_unit).toBe('');
    expect(result.notes).toBe('Pipetting anomaly detected during sample aspiration.');
  });

  it('keeps standard OBX-5 result path unchanged', () => {
    const obx = createObxSegment({
      'OBX.5.1': '1250',
      'OBX.6.1': 'copies/mL',
      'OBX.11': 'F'
    });

    const result = service.processHL7ResultValue(obx, service.getHL7ResultStatusType(obx));

    expect(result.results).toBe('1250');
    expect(result.test_unit).toBe('copies/mL');
    expect(result.notes).toBe('');
  });

  it('parses a representative HL7 result fixture', () => {
    const message = service.createHL7Message([
      'MSH|^~\\&|COBAS|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-001|P|2.5.1',
      'SPM|1|SAMPLE-001',
      'OBR|1|||HIVVL^HIV Viral Load',
      'OBX|1|NM|HIVVL^HIV Viral Load|1|1250|copies/mL|||||F|||||TECH-1|||20260714113000'
    ].join('\r'));
    const spm = message.get('SPM');
    const obx = message.get('OBX');

    expect(service.isValidHL7Message(message)).toBe(true);
    expect(service.extractHL7OrderAndTestIDs(spm, message)).toEqual({
      order_id: 'SAMPLE-001',
      test_id: 'SAMPLE-001'
    });
    expect(service.processHL7ResultValue(obx, service.getHL7ResultStatusType(obx))).toMatchObject({
      results: '1250',
      test_unit: 'copies/mL'
    });
  });

  it('rejects an HL7 fixture without required result segments', () => {
    const message = service.createHL7Message([
      'MSH|^~\\&|COBAS|LAB001|LIS|LAB001|20260714113000||OUL^R22|MSG-002|P|2.5.1',
      'SPM|1|SAMPLE-002'
    ].join('\r'));

    expect(service.isValidHL7Message(message)).toBe(false);
  });
});
