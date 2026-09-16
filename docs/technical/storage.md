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
| `results` | The result, as sent |
| `tested_by` | Operator recorded by the analyzer |
| `analysed_date_time`, `specimen_date_time`, `authorised_date_time` | As reported |
| `result_status` | `1` final, `0` not |
| `lims_sync_status` | `0` pending, `1` synced, `2` failed |
| `result_webhook_status` | Result forwarding only: `0` pending, `1` delivered, `2` not queued. Local to SQLite. See [result webhook](result-webhook.md). |
| `raw_text` | The records this row was parsed from |
| `notes` | Comment records, e.g. an analyzer's explanation of a failed run |

### `raw_data` — one row per transmission

What arrived, before it was understood. This is what makes a bad parse
recoverable: `raw-data-processor.service.ts` re-derives results from it without
asking the analyzer for anything. Keep it verbatim, or a defect found later
cannot be undone.

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

## Sync state

`lims_sync_status` distinguishes pending, synced and failed, and failed results
can be re-sent from the console. Nothing marks a result synced that was not
accepted: a result that has not reached the LIS has to stay visibly unsent,
because the alternative is a result nobody knows is missing.
