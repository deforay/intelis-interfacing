import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { DatabaseService, StoredTransmission } from '../../services/database.service';
import { transmissionSha256 } from '../../services/transmission-fingerprint';

/**
 * The records a result was read from, beside the whole transmission as it
 * arrived, so a result that looks wrong can be checked against what the
 * analyzer actually sent.
 */
@Component({
  standalone: false,
  selector: 'app-transmission-dialog',
  templateUrl: './transmission-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./transmission-dialog.component.scss']
})
export class TransmissionDialogComponent implements OnInit {
  public transmission: StoredTransmission | null = null;
  public loading = false;
  public lookupFailed = false;
  /** 'match', 'mismatch', or 'none' when no fingerprint was stored */
  public fingerprint: 'match' | 'mismatch' | 'none' = 'none';

  constructor(
    @Inject(MAT_DIALOG_DATA) public readonly result: any,
    private readonly dialogRef: MatDialogRef<TransmissionDialogComponent>,
    private readonly databaseService: DatabaseService,
    private readonly cdRef: ChangeDetectorRef
  ) { }

  async ngOnInit(): Promise<void> {
    if (!this.result?.transmission_id) {
      return;
    }
    this.loading = true;
    try {
      this.transmission = await this.databaseService.findTransmission(this.result.transmission_id);
      if (this.transmission?.sha256) {
        this.fingerprint = transmissionSha256(this.transmission.data) === this.transmission.sha256 ? 'match' : 'mismatch';
      }
    } catch (error) {
      console.error('Could not read the stored transmission:', error);
      this.lookupFailed = true;
    } finally {
      this.loading = false;
      this.cdRef.detectChanges();
    }
  }

  /** Framing and control bytes written as names, so they can be seen. */
  visible(text: string | null | undefined): string {
    const names: Record<string, string> = {
      '\x02': '<STX>', '\x03': '<ETX>', '\x04': '<EOT>', '\x05': '<ENQ>', '\x06': '<ACK>',
      '\x0b': '<VT>', '\x15': '<NAK>', '\x17': '<ETB>', '\x1c': '<FS>'
    };
    return String(text ?? '')
      .replace(/[\x02-\x06\x0b\x15\x17\x1c]/g, character => names[character])
      .replace(/\r\n|\r|\n|<CR>/g, '\n');
  }

  close(): void {
    this.dialogRef.close();
  }
}
