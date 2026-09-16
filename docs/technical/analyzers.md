# Analyzers as they behave

Taken from captures of live laboratories, not from documentation. Each is
reproduced as a fixture under `src/app/testing/fixtures/captured/` and replayed
by `src/app/services/analyzer-captures.spec.ts`, so a change that alters what a
real analyzer's message stores fails there first.

Field numbers count the record type as field 1, the way the parser indexes
them: in `O|1|S1|S1^RUN^A1`, `O.3` is `S1` and `O.4` is `S1^RUN^A1`.

## Cepheid GeneXpert — ASTM

- The `H` record declares its delimiters as `@^\` rather than `\^&`.
- One message per test, each in its own session.
- Frames are filled to 240 bytes and **cut wherever that falls**, so records
  split across `<ETB>` continuation frames, routinely mid-field.
- `O.3` is whatever the operator typed as the sample ID — sometimes a patient
  name, sometimes a free-text note.
- `R.1` carries the assay result with a trailing component separator:
  `NOT DETECTED^`, `DETECTED^`, `ERROR^`, `INVALID^`. For viral load the number
  is in the **second** component (`^1234.56`), `R.5` is the unit and `R.6` the
  reportable range.
- A `C` record explains an error: `Error^code^title^description^timestamp`.
- `O.26` is `F` even for a run that errored, so the result text and the comment
  are what say the run failed — not the status field.

### Locale changes everything except the shape

A GeneXpert 6.5 running in French sends `NON DÉTECTÉ`, `DÉTECTÉ`, `ERREUR`,
`PAS DE RÉSULTAT`, with `RÉUSSITE`/`NÉG`/`POS` on control records, and writes
every number with a decimal comma — in the result, the reportable range, and
every Ct and endpoint. Its error comments are French and contain a no-break
space. A viral load can come back `DÉTECTÉ` with **no number at all**, flagged
`<` in `R.7`, meaning detected below the reportable range — so the unit alone
does not tell you whether there is a number to read.

## Abbott m2000 — ASTM

- A whole run in one session: one `H`, then `P`/`O`/`R` per specimen.
- `O.4` is `specimenId^run^well`; only the first component is the identifier.
- Results include `Not detected`, `< 40`, and plain counts.
- A failed order arrives with **no `R` record at all** and `O.26` = `X`. The
  explanation is in a `C` record, e.g. `4442 : Internal control cycle number is
  too high.`
- Empty sessions — `<ENQ>` then `<EOT>` with nothing between — are normal
  between runs, as is a stray NUL byte.

## Roche COBAS AmpliPrep/TaqMan 96 — ASTM

Taken from AMPLILINK 3.3.5 and 3.3.7 logs, which hold the records but not the
framing.

- One message per sample: `H`, `P`, `O`, one `R`, several `C`, `L`. A session
  can carry a whole batch.
- `R.4` is the result as AMPLILINK wrote it, and the format depends on the
  version. 3.3.5 prints `2.52E+3 (3.40)`, a mantissa with its log value, and
  `R.5` is `cp/mL`. 3.3.7 sends the unrounded number, `1035.95864507225`, and
  `R.5` is `cp/ml`. `Target Not Detected` has an empty unit in both.
- Sample IDs are free text, double spaces included.
- The `C` records carry `Accepted` and the instrument flags, such as
  `TM40^ STEP_CORR-2`. The notes keep the text of each, `STEP_CORR-2`, and drop
  the flag code.
- The order record stops at `O.12`, so it has no `O.26` report type, which is
  where every ASTM analyzer's final status is read from. TaqMan results are
  therefore stored as not final. TaqMan does mark each result `V` (verified)
  in `R.9`, but nothing reads that field today.
- `O.5` names the test `^^^ALL`, so the test type is stored as `ALL`. The assay
  code, `HI2CAP96`, is only in `R.3`.
- Both of those are open until a TaqMan laboratory confirms what its LIS
  expects.
- **Checksums are unconfirmed.** An AMPLILINK simulator trace shows standard
  frames with checksums, and the laboratory setup is remembered as sending
  none. Both are tested. Choose the ASTM protocol that matches what the
  instrument actually sends.
- **In every log, the LIS asked for results** with a `Q` record before
  AMPLILINK sent them. This tool does not send queries, so AMPLILINK has to be
  set to send results without being asked.

## Abbott Alinity m — HL7

- **`SPM.2` and `SPM.3` are always empty.** The sample identifier is in `SAC.3`.
  Reading it from the specimen segment, as most analyzers would have it, stores
  an empty sample ID.
- `OBX.6` is `^Copies/mL`: the identifier component empty, the text filled.
- Sixteen `INV` segments and an `NTE` sit between the result `OBX` and the
  supplemental ones.
- Not-detected and below-range outcomes come through as text rather than
  numbers.

## Roche cobas 4800, 5800, 6800/8800 — HL7

All three send OUL^R22 over MLLP and disagree about where things are.

- **The `&ROCHE` suffix is a 4800 and 5800 habit.** Both send `SPM.2` as
  `<id>&ROCHE`, and it is stripped to get the identifier; the 5800 repeats the
  plain identifier in `SAC.3`. The 6800/8800 sends a plain `SPM.2` with no
  suffix, and leaves `SPM.1` empty.
- **6800/8800**: four `OBX` per sample. The **first** carries the result —
  a value, or `ValueNotSet` with a flag in `OBX.8` (`ND`, `BT`, `RR`, `NR`).
  The second is `NA` with Ct values, and the fourth the textual outcome. An
  invalid run has an empty second `OBX`, flags such as `P02T`, and `OBX.11` = `X`.
- **5800**: a quantitative result is `NM` with a three-digit mantissa in `OBX.5`
  and a UCUM power of ten in `OBX.6` — 367 with `10*-1.{copies}/mL`. Both are
  stored as sent; multiplying them out is the LIS's job, not this tool's.
- **4800**: one message per run, every sample in it. Each specimen group
  carries two `OBX`. The first is a run-time range; the **second** is the
  result, as text: `3.26E+05 cp/mL` with unit `1/mL^^UCUM`, or
  `Target Not Detected`, `< Titer min`, `> Titer max`, `Invalid`, `Failed`.
  The qualitative assay `0BHIV1QUAL` reports `Not Detected`, `Detected`, and
  `Valid` on its control.
- **4800 result status**: `OBX.11` is `F`, `X` for a failed run, or `P`. `P`
  is how at least one laboratory reports: nearly every sample it sent as `P` was
  never sent again as `F`. HL7 results are therefore all stored as final.
- **4800 flags**: `NTE` 1 carries the run flags (`F;X2,X3`, `F;R3223,X2`). They
  are what explains a `Failed` or `Invalid` result, and they are not kept in
  the notes today.
- **4800 `> Titer max`** was always rewritten to `> 10000000` in code (and
  `>10000000` by older versions). It is now a result rule: HL7 instruments
  configured before 4.5.0 start with it, new ones store `> Titer max` as sent.
- A 4800 control can fail before it is identified: `SPM.2` is `&ROCHE` and
  `SAC.3` is empty. Its sample ID is stored empty.
- Instrument errors and flags arrive as text and are stored as `Failed` with the
  detail kept in the notes.

## The generic choices

`Other ASTM (with checksum)`, `Other ASTM (without checksum)` and `Other HL7`
parse the standards without model-specific field mapping. An analyzer that is in
the list above will store results under a generic choice, but fields that depend
on knowing the dialect — which component holds the specimen ID, what an empty
result field means — may come through empty.

## Adding an analyzer

1. Capture what it actually sends. The stored raw transmissions are the source;
   a vendor's document is a description of them.
2. Anonymise: identifiers, operator names, serial numbers, dates. Record
   layouts, value formats and framing stay exactly as transmitted.
3. Add it as a fixture under `src/app/testing/fixtures/captured/`, with a header
   comment saying what the capture showed.
4. Replay it in `analyzer-captures.spec.ts`, asserting the stored rows.
5. Only then write the mapping.
