# What is stored, and where

## The data directory

One folder per machine, named independently of the application so a rename
cannot move it:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\vlsm-interfacing` |
| Linux | `~/.config/vlsm-interfacing` |
| macOS | `~/Library/Application Support/vlsm-interfacing` |

It holds `interface.db`, `config.json`, `logs/`, `backups/`,
`sqlite-migrations/` and `mysql-migrations/`. A served development run
deliberately uses Electron's default directory instead, so working on the tool
cannot write into an installation's data on the same machine.

## The tables

The same shape in SQLite and, when configured, MySQL.

### `orders` — one row per result

| Column | Notes |
|--------|-------|
| `order_id`, `test_id` | The sample identifier as the analyzer sent it. Never inferred, cleaned or trimmed into shape — that would attach a result to a different patient. |
| `test_type`, `test_unit` | Assay and unit, as sent |
| `results` | The result as stored: as sent, unless one of the instrument's result rules replaced it |
| `results_as_sent` | The result as read from the transmission, before result rules. `Failed` or `Incomplete` when the analyzer marked the run so, with its own text in `notes`. `NULL` on results stored before 4.5.0. |
| `tested_by` | Operator recorded by the analyzer |
| `analysed_date_time`, `specimen_date_time`, `authorised_date_time` | As reported |
| `result_status` | `1` final, `0` not |
| `lims_sync_status` | `0` pending, `1` synced, `2` failed |
| `result_webhook_status` | Result forwarding only: `0` pending, `1` delivered, `2` not queued. Local to SQLite. See [result webhook](result-webhook.md). |
| `raw_text` | The result's own records. For ASTM: the message header, the patient record the order follows, and the order with the records after it. For HL7: the message header and the specimen's segments, or the whole message when it cannot be split by specimen. Before 4.8.0: the whole message or read buffer. |
| `transmission_id` | The `raw_data.transmission_id` of the transmission the row was read from. `NULL` on rows stored before 4.8.0 until **Compact Storage** links them. |
| `repeated` | `1` when reprocessing stored the row beside a different result for the same sample and test |
| `notes` | Comment records, e.g. an analyzer's explanation of a failed run |

### `raw_data` — one row per transmission

What arrived, before it was understood. This is what makes a bad parse
recoverable: `raw-data-processor.service.ts` re-derives results from it without
asking the analyzer for anything. Keep it verbatim, or a defect found later
cannot be undone.

| Column | Notes |
|--------|-------|
| `data` | The transmission as received |
| `transmission_id` | A unique UUID, given when the transmission is stored. It is the same in SQLite and MySQL, where the row ids differ. A transmission stored before 4.8.0 gets one when it is first reprocessed, compacted or copied to MySQL. If MySQL already held a copy, each database gives its copy a different UUID. Results point to the UUID in their own database. |
| `sha256` | SHA-256 of `data` as UTF-8, taken when it is stored. The console's original-data view checks it. |

The transmission is kept once. Its results point to it by `transmission_id`.
Nothing in the tool changes or deletes a `raw_data` row. Compacting only fills
in `transmission_id` and `sha256` where they are missing.

### Reprocessing and compacting

Reprocessing (`RawDataProcessorService.reprocessRawData`, `reprocessMatching`)
reads transmissions again. It stores a result only when neither database holds
an identical one. `DatabaseService.findIdenticalResult` compares the sample,
instrument, test, value, value as sent, unit, notes, operator, times and
status. The sample ID must match exactly, case included. Reprocessing checks
every result of a transmission before it stores any of them, then stores them
one at a time. A stored result links to its transmission. Bulk runs walk
`raw_data` by id in batches, up to the newest matching id when the run starts.

Compacting (`RawDataProcessorService.compactStorage`) walks each database's
`raw_data` newest first. For each transmission, it reads the results with the
current parser and does not save them. For each sample ID, it takes the
unlinked `orders` rows stored no earlier than five minutes before the
transmission. It links a row only when every record of the row's `raw_text`
appears whole and in order in the transmission. `recordsOf` sets aside
framing, frame numbers and checksums for this comparison. It replaces
`raw_text` only when exactly one parsed run matches the row. Otherwise it
leaves `raw_text` whole. It then runs `VACUUM` on SQLite or
`OPTIMIZE TABLE orders` on MySQL.

The tool also compacts by itself (`scheduleAutomaticCompaction`), two minutes
after it starts, once per database. It skips a database with no unlinked
result that has `raw_text`. It changes only settled results: `lims_sync_status`
not pending, `result_webhook_status` not pending once result forwarding has
been saved (SQLite only), and `added_on` more than seven days ago. It does not
run `VACUUM` or `OPTIMIZE` while running. When it removed at least 10 million
characters from SQLite, it sets `storageReclaimPending`, and the main process
runs `VACUUM` at the next start, after migrations and before it creates the
window. The request is cleared before the rewrite, so a failed rewrite is
logged and not repeated at every start. A finished
run is recorded in the settings store under `storageCompacted`, keyed `sqlite`
or `mysql:<host>:<port>/<database>`, and is not repeated. Settings export
leaves this record out. Reprocessing, or Compact Storage pressed in Settings,
stops the automatic run first, because they share the Stop request. The
automatic run waits while either is running, rewrites included. A stopped or
failed run starts again at the next start.

### `app_log`, `telemetry_events`, `usage_statistics_daily`, `versions`

Operational log; PII-free usage events and their daily aggregates (see
[usage statistics](telemetry.md)); and the record of which migrations have run.

## Migrations are append-only

`app/sqlite-migrations/*.sql` are applied in order and recorded in `versions`.
They are copied into the data directory at startup so an installation carries
the migrations it has actually applied.

**An applied migration is never edited.** A machine in a laboratory has already
run it; changing the file means that machine's schema and a freshly installed
one will never agree again, and nothing will report the difference. Add another
migration instead. `npm run test:migrations` applies the whole chain to an empty
database and fails on a gap or a re-ordering.

## The rule that governs every value

Stored exactly as the analyzer sent it. No rounding, no locale normalisation, no
unit conversion, no `< 40` turned into `40`, no decimal comma turned into a
point.

This has bitten before, which is why it is written down. Earlier versions
expanded scientific notation and applied UCUM exponents on the way in; a result
that had been transformed could not be checked against the analyzer's own
printout, and the transformation was not always right. The conversion belongs
wherever the value is interpreted — the LIS — not at the point it is captured.

The one exception is the laboratory's own. An instrument's
[result rules](../guide/settings.md#result-rules) can store `Y` where the
analyzer sent `X`, because that laboratory's LIS expects `Y`. The tool never
decides that itself: every rule is typed by the laboratory, the replacement is
taken literally, `results_as_sent` keeps the result as read before any rule on
every result, and `Failed` and `Incomplete` are never replaced, so no rule can
make a failed run read as a result.

## Sync state

`lims_sync_status` distinguishes pending, synced and failed, and failed results
can be re-sent from the console. Nothing marks a result synced that was not
accepted: a result that has not reached the LIS has to stay visibly unsent,
because the alternative is a result nobody knows is missing.
