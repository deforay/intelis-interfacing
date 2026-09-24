# Raw data, and recovering results from it

Every transmission an analyzer sends is stored exactly as it arrived, before
the tool tries to understand it. **Console → View Raw Data** shows them: which
instrument, when, and the transmission itself.

The tool stores each transmission once, with an identifier and a SHA-256
fingerprint of its content. Every result read from a transmission carries its
identifier. The result keeps only its own records, not a copy of the whole
transmission.

To see where a result came from, press **Show original data**, the file icon
at the end of its row in the console. The window shows the result's records and the whole transmission. It
also shows whether the transmission still matches its fingerprint.

That record exists for one reason. If the tool ever read a transmission wrongly,
the analyzer does not have to send it again — the result can be worked out from
what was stored, once the reading is fixed.

## When you would use it

- **A version of the tool stored results wrongly, and a newer one fixes it.**
  This is the usual case, and the one below.
- **A result did not appear at all** although the console log shows the
  transmission arriving.
- **Someone needs to see exactly what the analyzer said** — the raw record is
  the evidence, not the row in the results table.

## Reprocessing

1. Upgrade first. Reprocessing reads transmissions with the version you are
   running now, so on an old version it reproduces the same wrong reading.
2. Open **Console → View Raw Data**.
3. Fill in the filter fields you need:
    - **Instrument**: one instrument, or all of them.
    - **Received from** and **Received to**: the first and last day. Both days
      are included. The days are compared with the received time the list
      shows.
    - **Contains**: text in the transmission, such as a sample ID.
4. Press **Apply**. The count under the filter covers every matching
   transmission, on all pages.
5. Choose what to reprocess:
    - To reprocess some transmissions, tick them and press **Reprocess Selected**.
    - To reprocess every matching transmission, press **Reprocess All
      Matching**. It works through them oldest first.
    - To reprocess one transmission, press **Reprocess** on its row.
6. Watch the progress card. It counts transmissions done, new results, results
   already stored, transmissions with no results in them, and transmissions not
   fully read. A transmission with no results in it, such as an analyzer asking
   the LIS for a sample's orders, is expected. A transmission not fully read
   needs a look.
7. To end a run early, press **Stop**. The run stops after the current
   transmission. Results it already stored stay stored.

A run does not include transmissions that arrive after it starts.

!!! warning "Reprocessing stores changed results as new results. It does not correct stored ones."

    Reprocessing reads each transmission again with the current version and
    settings. If a result is already stored exactly as read, reprocessing
    does not store it or send it to the LIS again. Exactly means the same
    sample, test, value, unit, notes, operator and times. Reprocessing a range
    that is already right changes nothing.

    If a result reads differently, reprocessing stores it as a **new** result
    and queues it for the LIS. The earlier result stays where it is. The
    results table then shows both under the same sample ID. If the sample
    already had a result for the same test, the new result has
    `repeated = 1`.

    A new result for a sample the LIS already accepted may not be wanted.
    Before you reprocess a run of any size, agree with whoever runs the LIS
    what happens to results the LIS already accepted. For a handful of
    samples, this is a conversation. For several hundred, it is a plan.

## Recovering from the framing defect in versions before 4.2.0

Analyzers that split records across frames — the Cepheid GeneXpert in
particular, which fills 240-byte frames and cuts records wherever that falls —
were read incorrectly by versions before 4.2.0. Depending on where the cut
landed, a result was stored either **empty** or **truncated**, sometimes with
stray characters where the unit should be, such as `co␗E4` instead of
`copies/mL`.

One laboratory had 97 of 136 results stored empty this way, and synced to their
LIS as empty, without anything appearing to go wrong.

Nothing was lost. The transmissions were stored intact, and every one of those
136 results can be read correctly by the current version. To recover:

1. **Upgrade to 4.2.0 or later.**
2. **Check a single transmission first.** Reprocess one, and compare the new
   result against the analyzer's own printout for that sample. It should match
   exactly, including how the number is written.
3. **Agree the plan with your LIS** — see the warning above. The affected
   samples already went across as blank or truncated, and correcting them is
   the LIS's business as much as this tool's.
4. **Then reprocess the rest** in batches. Filter to one day or one
   instrument, press **Reprocess All Matching**, and check the results before
   the next batch.

!!! tip "How to tell whether you are affected"

    Look in the results table for results that are blank, or that end in
    stray characters, or units that read like `co` or `cop` rather than
    `copies/mL`. Sort by sample ID: an affected run tends to show a stretch of
    them together, because the analyzer was behaving consistently.

## Reclaiming database space

Versions before 4.8.0 stored a copy of the whole transmission on every result
read from it. An analyzer that sends a batch in one message multiplies that
copy. A cobas 4800 run of 94 samples stored 94 copies of a 56 KB message. One
laboratory's database grew to 3.8 GB this way, and copies made up 3.35 GB of
it.

The tool compacts these copies by itself. About two minutes after it starts,
it links each older result to its stored transmission and keeps only the
result's own records. It does this once for this computer's database, and once
for the MySQL database when one is configured and answers. It runs in the
background while results keep arriving. **Settings → Troubleshooting →
Storage** shows its progress, and the application log records what it did.
If the tool closes first, it starts again at the next start.

The automatic run changes only results that are settled:

- already sent to the LIS, or refused by it;
- already delivered by result forwarding, when forwarding has been set up;
- stored more than a week ago.

It leaves other results whole, and does not come back to them. Compact Storage
covers them.

When the automatic run frees space in this computer's database, the tool gives
it back to the disk at its next start, before it opens its window and so before
any instrument can connect. A small window with a moving bar shows while it
runs. This takes seconds on a compacted database. The
MySQL database is not rewritten automatically, because other installations or
the LIS can be using it at the same time.

To compact everything at once, and give the space back to the disk now:

1. Take a backup. See [backup and restore](backup-restore.md).
2. Open **Settings → Troubleshooting**.
3. In the **Storage** card, press **Show Storage Use** to see the current
   sizes.
4. Press **Compact Storage**, read the confirmation, then press
   **Compact Storage** again. Results keep arriving while it runs.
5. When it asks, press **Restart Now** or **At Next Start**. Restarting
   interrupts every current instrument connection, so wait until no analyzer
   is sending. With auto-connect on, the instruments reconnect when the tool
   opens again.

Compact Storage makes these changes:

- It links each older result to the stored transmission it came from.
- It replaces the result's copy with the result's own records. It does this
  only when every record of the copy is in the stored transmission.
- It leaves the copy whole in three cases: the transmission is not stored,
  the result has no sample ID, or the result does not match a single run in
  the transmission.
- It never changes or removes a stored transmission, and sends no result to
  the LIS again.
- It covers this computer's database and, when one is configured, the MySQL
  database. It rebuilds the MySQL `orders` table at the end.
- It rewrites this computer's database at the next start, before any
  instrument can connect. The rewrite needs free disk space about the size of
  the compacted database.

On that laboratory's database, Compact Storage linked 62,332 of 63,003 results
in a few minutes. The database shrank from 3.4 GB to 113 MB.
