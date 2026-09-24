/**
 * The SHA-256 of a stored transmission, as hex: what shows that raw data
 * read back is the transmission as it was stored. Taken over the text as
 * the application reads and writes it, so SQLite and MySQL agree.
 */
export function transmissionSha256(data: string): string {
  const crypto = (window as any).require('crypto');
  return crypto.createHash('sha256').update(data ?? '', 'utf8').digest('hex');
}
