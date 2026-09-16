# Technical guide

For people changing this code, integrating with it, or working out why a result
looks the way it does.

- **[How it is put together](architecture.md)** — the processes, what runs
  where, and why the renderer's privileges are load-bearing.
- **[Protocols on the wire](protocols.md)** — ASTM E1381 framing and E1394
  records, HL7 over MLLP, and the failure modes that are not in the standards.
- **[Analyzers as they behave](analyzers.md)** — what each model actually sends,
  taken from captures of live laboratories rather than documentation.
- **[What is stored, and where](storage.md)** — the tables, the migrations, and
  the rule that governs every value in them.
- **[Result webhook](result-webhook.md)** — the JSON request an HTTP receiver
  gets for each batch of results, and when a result counts as delivered.
- **[Usage statistics](telemetry.md)** — what is recorded locally and what
  leaves the machine.
- **[Building and releasing](building.md)** — the gate, the release, and the
  identifiers that must not move.

## The one rule worth reading first

A value is stored exactly as the analyzer sent it. No rounding, no locale
normalisation, no unit conversion, no `< 40` turned into `40`.

The analyzers disagree with each other about almost everything — decimal
commas, `TND` versus `Not detected` versus `Target Not Detected`, mantissas with
power-of-ten units — and each of those disagreements is the laboratory's to
resolve, not this tool's. A tool that tidied values on the way past would be a
tool whose output nobody could check against the analyzer's own printout, and
the person at the end of that chain is a patient on treatment.

Everything else in this guide is downstream of that.
