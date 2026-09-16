# Review brief

Read adversarially. This tool stands between an analyzer and a laboratory
information system, and the person at the end of it is a patient on treatment.
So the first question about a change is not "does it work" but **can a result
now reach the LIS as something other than what the instrument said** — a
different number, a different unit, a result attached to the wrong sample, or
no result at all where the instrument sent one.

A silent wrong answer is worse than a loud failure. Rank findings that way.

## Invariants

1. **A value is stored exactly as the analyzer sent it.** No rounding, no
   locale normalisation, no unit conversion, no "<40" turned into 40. The
   analyzers speak different dialects — decimal commas, French result words,
   `TND`, `Not detected`, `Target Not Detected` — and every one of them is
   the laboratory's to interpret, not ours. A change that rewrites a value on
   the way in is a defect even when the new value looks tidier. The only
   rewrite allowed is a laboratory's own result rule, configured per
   instrument, and even then `results_as_sent` must hold the result as read
   before any rule, and no rule may replace `Failed` or `Incomplete`.
2. **The raw transmission is kept verbatim.** `raw_data` is what makes a bad
   parse recoverable: reprocessing re-derives results from it. Anything that
   normalises, truncates or drops the stored bytes destroys the only copy.
3. **No byte of framing may survive into a field.** Records arrive cut across
   ETB continuation frames, mid-field, and are rejoined before parsing. A
   control character, a frame number or a checksum inside a result, a unit or
   a sample ID has already gone to the LIS by the time anyone notices.
4. **A sample ID is never inferred.** It comes from the record, whatever the
   operator typed into it. Guessing, trimming or "cleaning" one attaches a
   result to a different patient.
5. **A failed or errored run must not read as a valid result.** Some analyzers
   send the same final status on a run that errored, so the result text and the
   comment records are what say so. Neither may be dropped.
6. **Migrations are append-only.** `app/sqlite-migrations/` is applied in order
   and recorded in the versions table; an edited migration is a machine in the
   field that will never match one installed today.
7. **A result is not lost because a sync failed.** Pending, synced and failed
   are distinct states and a retry path exists. Nothing may mark a result
   synced that was not accepted.
8. **The renderer runs with Node integration.** `scripts/check-electron-safety.mjs`
   says what keeps that safe. Instrument and LIS text reaching the DOM through
   anything but Angular interpolation is remote code execution, not a rendering
   choice.
9. **Secrets stay encrypted at rest**, and nothing logs them. Logs are shipped
   to us by laboratories, so the same goes for patient identifiers.

## What a finding must look like

Concrete: the input, the state, and the wrong row or crash it produces. A
transmission that would trigger it beats a description of it. If a defect could
be caught by a test in `analyzer-captures.spec.ts` or through
`wire-harness.ts` and is not, say so — the missing test is part of the finding.

Say plainly when a thing you looked at is fine. A review that reports
everything as a risk tells the reader nothing about where to look first.
