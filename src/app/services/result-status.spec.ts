import { describe, expect, it } from 'vitest';
import { resultStatusDisplay, statusAsSent, statusFromRawText } from '../../../shared/result-status';

describe('the analyzer status of a result', () => {
  it('stores the letter trimmed and in upper case, and nothing for an empty one', () => {
    expect(statusAsSent(' f ')).toBe('F');
    expect(statusAsSent('')).toBeNull();
    expect(statusAsSent(undefined)).toBeNull();
  });

  it('shows the letters both protocols share in words', () => {
    expect(resultStatusDisplay({ results: '1250', result_status_as_sent: 'F' })).toMatchObject({ label: 'Final', tone: 'final' });
    expect(resultStatusDisplay({ results: '1250', result_status_as_sent: 'C' })).toMatchObject({ label: 'Corrected', tone: 'final' });
    expect(resultStatusDisplay({ results: '1250', result_status_as_sent: 'P' })).toMatchObject({ label: 'Preliminary', tone: 'pending' });
    expect(resultStatusDisplay({ results: '', result_status_as_sent: 'X' })).toMatchObject({ label: 'Cannot be done', tone: 'failed' });
  });

  it('never shows a failed run as final, whatever letter came with it', () => {
    expect(resultStatusDisplay({ results: 'Failed', result_status_as_sent: 'F' })).toMatchObject({ label: 'Failed', tone: 'failed' });
    expect(resultStatusDisplay({ results: 'Invalid', result_status_as_sent: null })).toMatchObject({ label: 'Failed', tone: 'failed' });
    expect(resultStatusDisplay({ results: 'Incomplete', result_status_as_sent: 'F' })).toMatchObject({ label: 'Incomplete', tone: 'pending' });
  });

  it('shows a letter that differs between ASTM and HL7 as sent', () => {
    expect(resultStatusDisplay({ results: '1250', result_status_as_sent: 'R' })).toMatchObject({ label: 'Status R', tone: 'unknown' });
  });

  it('shows a dash, not a guess, when the letter was not kept', () => {
    expect(resultStatusDisplay({ results: 'Target Not Detected', result_status_as_sent: null })).toMatchObject({ label: '-', tone: 'unknown' });
  });
});

describe('finding the status of an earlier result in its own records', () => {
  it('reads OBX.11 when every OBX segment agrees', () => {
    const text = 'MSH|^~\\&|GX\rSPM|1|S1\rOBX|1|ST|HIV|1|1250|cp|||||F\rOBX|2|ST|LOG|1|3.1|log|||||F';
    expect(statusFromRawText(text, 'S1')).toBe('F');
  });

  it('leaves an HL7 result empty when its OBX segments disagree', () => {
    const text = 'MSH|^~\\&|GX\rOBX|1|ST|HIV|1|1250|cp|||||F\rOBX|2|ST|HIV|1|300|cp|||||P';
    expect(statusFromRawText(text, 'S1')).toBeNull();
  });

  it('reads O.26 from ASTM records joined with <CR>, frame numbers and all', () => {
    const order = (id: string, status: string) => `O|1|${id}||^^^HIV|R||||||||||||||||||||${status}`;
    expect(order('S1', 'F').split('|')[25]).toBe('F');
    expect(statusFromRawText(`1H|\\^&|||m2000<CR>2P|1<CR>3${order('S1', 'F')}<CR>4R|1|^^^HIV|1250`, 'S1')).toBe('F');
  });

  it('picks the order record of the sample when a whole message was stored', () => {
    const order = (id: string, status: string) => `O|1|${id}||^^^HIV|R||||||||||||||||||||${status}`;
    const text = ['H|\\^&', 'P|1', order('S1', 'F'), 'R|1|^^^HIV|1250', 'P|2', order('S2', 'P'), 'R|1|^^^HIV|300', 'L|1'].join('<CR>');
    expect(statusFromRawText(text, 'S2')).toBe('P');
    expect(statusFromRawText(text, 'S3')).toBeNull();
  });

  it('returns nothing for a result with no records', () => {
    expect(statusFromRawText(null, 'S1')).toBeNull();
  });
});
