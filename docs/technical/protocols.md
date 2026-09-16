# Protocols on the wire

Two protocols, and the parts of them that cause trouble in the field.

## ASTM: E1381 framing, E1394 records

**E1394** defines the records: `H` header, `P` patient, `O` order, `R` result,
`C` comment, `L` terminator, fields separated by `|`, components by `^`, each
record ending in CR.

**E1381** defines how those records cross a serial line or a socket:

```
<ENQ>                                    the analyzer asks to send
                                  <ACK>  the tool agrees
<STX> 1 <records> <ETX> cc <CR><LF>      a frame, ETX = last of the message
                                  <ACK>  acknowledged
<EOT>                                    the analyzer is done
```

Frame numbers run 1–7 then 0, restarting for each message. `cc` is the checksum:
the modulo-256 sum of every byte after `<STX>` up to and including the
terminator, as two uppercase hex digits.

### Records get cut wherever the frame ends

This is the single most consequential fact about ASTM in practice. A frame holds
a bounded number of bytes — the GeneXpert fills 240 — and a record longer than
what is left is **cut wherever that falls, mid-field, mid-word**. The frame ends
in `<ETB>` instead of `<ETX>`, and the record continues at the start of the next
one:

```
R|1|^^^HIV-1^Xpert HIV-1 Viral Load XC^3^^|DÉTECTÉ^|co<ETB>E4<CR><LF>
<STX>2pies/mL|40,00 to 10000000,00|<||F||...
```

`co` + `pies/mL` is `copies/mL`. Rejoining across `<ETB>cc<CR><LF><STX>n` has to
happen **before** the stream is split into records. Get it wrong and the result
either keeps the frame's checksum inside it — `co<ETB>E4` stored as a unit — or
loses every field after the cut, which is how a laboratory ends up with 97 of
136 results stored empty and synced to their LIS that way.

### Checksum mode and non-checksum mode

Both are in the field, because both are settings on the analyzers.

- **With checksums**, each frame is verified and a frame that fails is `NAK`ed
  so the analyzer sends it again.
- **Without**, there is nothing to verify, but a read is still taken apart
  first: every frame, and every `<ENQ>`, `<EOT>` and `<NAK>`, is handled as if
  it had arrived on its own. A whole session delivered in one read is then
  completed at its `<EOT>`, each message keeps its own raw text, and `<ENQ>` is
  acknowledged without becoming part of the stored transmission.

The tool has to be told which, because a frame's trailing two characters are
either a checksum to strip or two characters of data.

### A retransmitted frame is not a second record

If the analyzer's `<ACK>` does not arrive it sends the same frame again — same
frame number, since a new frame always advances. Appending it twice duplicates
its records, and a duplicated `O` record becomes a second order with no `R`
records behind it: a result saved as a failure against a sample that in fact has
a result, sitting next to the true one, both queued for the LIS.

A frame carrying the number of the one before it is acknowledged and dropped.
It is deliberately kept out of the stored transmission too: framing is gone by
the time raw data is read back, so a second copy of a record in there cannot be
told from a second order, and re-processing would write exactly the row the
check prevents.

## HL7 v2 over MLLP

An HL7 message is wrapped in a **minimal lower layer protocol** block:

```
<VT> MSH|^~\&|... <FS> <CR>
```

`<VT>` (0x0B) opens, `<FS>` (0x1C) closes, `<CR>` terminates. The tool answers
with an `ACK` echoing the message control ID, HL7 version and character set.

Two tolerances matter, because analyzers in the field need both:

- **The `<VT>` may be missing.** Some analyzers just start with `MSH`.
- **The `<CR>` may be missing, or late.** TCP splits wherever it likes, so a
  block can end one chunk at `<FS>` and have its `<CR>` arrive in the next.

A block is therefore complete at `<FS>`, but held briefly for a `<CR>` that may
still be coming, so the transmission stored is the one that was sent rather than
one byte short of it. When no `<CR>` follows, or the connection goes away first,
the block is taken as it stands — an analyzer that never sends a terminator has
still finished sending a result, and waiting for a byte it will not send would
lose it.

### A batch message is read one specimen at a time

Most analyzers send one message per sample. The cobas 4800 sends one message
for a whole run, every sample an `SPM` followed by its own `SAC`, `OBR` and
`OBX` segments. Looked up across the whole message, a sample's fallback ID
(`SAC.3`), test type (`OBR.4`) and result `OBX` can belong to another sample:
a sample with no ID would take the first sample's, and a sample whose result is
missing would take someone else's.

So a message with more than one `SPM` is split, and each sample is read only
from its own group: its `SPM` and every segment after it up to the next `SPM`,
behind the message header. Within a group:

- the sample ID falls back to the group's own `SAC.3`;
- the test type comes from the group's own `OBR`, not one that precedes the
  first `SPM`, when the group has one;
- the result is the group's first result `OBX`. A run-time range is never taken
  as a result.

A sample whose group has no result is recorded as a parse failure and stored
nowhere. A message with one `SPM` is read as a whole, exactly as before.

The split assumes each specimen is followed by its own results, as `OUL^R22`
has it and as every analyzer captured so far sends. Two layouts do not do that
and are read as a whole, as they always were: results before the first `SPM`,
and every `SPM` listed before all of the results.

## What both have in common

**The raw transmission is stored before it is understood.** Framing, records and
all. It is what makes a bad parse recoverable: when a defect is found and fixed,
re-processing the stored transmissions re-derives the results, and nothing has
to be asked of the analyzer again. It is also the only evidence available when a
laboratory reports a result that looks wrong.
