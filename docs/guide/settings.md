# Settings

The Settings page is organised into sections down the left-hand side. Nothing
takes effect until you press **Save Settings**.

## System

| Field | What it is |
|-------|------------|
| **Testing Lab Code/ID** | A unique identifier for the laboratory, e.g. `LAB001`. It travels with every result. |
| **Testing Lab Name** | The laboratory's name, as it should appear on results. |
| **Date Format** | How dates are shown on screen: `16-Sep-2026` (the default), `16-09-2026`, `16/09/2026`, `16.09.2026`, `09/16/2026` or `2026-09-16`. Each choice is shown with today's date. Stored results, raw data and what the LIS receives keep their own format; hovering a date in the results shows the stored value. |
| **Auto-connect on startup** | `Yes` skips the login screen and connects every instrument when the application opens. `No` shows the login screen and leaves connecting to you. |

The **SQLite Database Path** is shown rather than asked for: it is where results
are stored on this machine, and the tool decides it.

## MySQL *(optional)*

Configure this if your LIS reads results from MySQL.

| Field | What it is |
|-------|------------|
| **MySQL Host** | Database server address, e.g. `127.0.0.1` |
| **MySQL Port** | Default `3306` |
| **Database Name** | e.g. `interfacing` |
| **Database User** | MySQL username |
| **Database Password** | MySQL password |

**Test Connection** proves the database is reachable before you save a
configuration that depends on it.

!!! info "MySQL is optional"

    Without it, results are still stored locally in SQLite. What you lose is the
    shared table an LIS on another machine can read.

## Instruments

**+ Add Instrument** for each analyzer this tool will talk to.

### Connection

| Field | What it is |
|-------|------------|
| **Connection Mode** | `TCP Server` — the analyzer connects to this tool. `TCP Client` — this tool connects to the analyzer. The analyzer's own configuration decides which one you need. |
| **Communication Protocol** | `ASTM`, `ASTM (with checksum)`, or `HL7`. |
| **IP Address** | In server mode, the address on this machine to listen on. In client mode, the analyzer's address. |
| **Port Number** | 1–65535, matching what the analyzer is configured for. |

!!! warning "Checksum or not is the analyzer's decision, not a preference"

    An analyzer configured to send checksums and a tool configured not to expect
    them will still appear to work, and will still store results. What is lost is
    the check that a frame arrived intact, and the ability to ask for it again
    when it did not. Set this to what the analyzer is actually doing. If you are
    unsure, [the console log](console.md#connection-logs) shows which one it is
    reading.

### The instrument itself

| Field | What it is |
|-------|------------|
| **Analyzer Type** | The model. Roche cobas Taqman, 4800, 5800, 6800/8800; Abbott m2000, Alinity m; Cepheid GeneXpert; or one of the generic ASTM and HL7 choices. |
| **Instrument Name/Code** | The name the LIS knows this analyzer by. It is what results are mapped by, so it has to match what the LIS expects. |
| **Display Order** | The order the instruments appear in on the console. |

Each instrument needs a unique name and a unique address-and-port combination.

!!! tip "Why the analyzer type matters"

    Two analyzers can both speak ASTM and still disagree about where the sample
    identifier lives or what an empty result field means. The analyzer type is
    how the tool knows which of those dialects it is listening to. Choosing
    "Other" for a model that is in the list will store results, but some fields
    may come through empty.

### Result rules

Result rules tell the tool to store a different value when an instrument sends
a particular result. Use them when your LIS expects a result written in a way
the instrument does not send it. Each instrument has its own rules.

| Field | What it is |
|-------|------------|
| **Is exactly / Contains** | Whether the whole result must match, or only part of it. Spaces around the result are ignored. |
| **Result** | The text the instrument sends, e.g. `> Titer max`. |
| **Store instead** | The value to store. It replaces the whole result, exactly as typed. |
| **Ignore case** | Match `NOT DETECTED` and `Not Detected` alike. |

The first rule that matches is used. A result that no rule matches is stored
exactly as the instrument sent it. `Failed` and `Incomplete` are never
replaced, so no rule can make a failed run look like a result.

- A rule with either text left empty is ignored.
- **Contains** also matches inside numbers: a rule for `20` matches `1200`.
- Rules stay with the instrument if you change its protocol. Review them when
  you do.

- **Duplicate** copies one rule, to change it slightly.
- **Copy from another instrument** lists the instruments that have rules.
  Choose one to add its rules to this instrument. Rules this instrument
  already has are skipped.

An instrument with no rules shows a single line under **Result rules**, with
**Add rule** and **Copy from another instrument**.

The result as read before any rule is always kept beside the stored one, and
the raw data never changes. After changing a rule, reprocess older raw data to store
earlier results the new way. If the rule changes a result, reprocessing stores
a new result beside the old one. If the rule leaves a result unchanged,
reprocessing does not store it again. See
[raw data and recovery](raw-data.md#reprocessing).

!!! note "Rules you may already have"

    Earlier versions always stored `> Titer max` as `> 10000000` and `<20` as
    `< 20` for HL7 instruments. Those are now the starting rules of every HL7
    instrument configured before this version, so nothing changes until you
    edit or remove them. A new instrument starts with no rules.

Check with your LIS administrator before adding a rule. The LIS reads the value
you store, not the one the instrument sent.

## LIS API *(optional)*

If your LIS offers an API, the tool can fetch the instrument names it expects,
so the names on both sides match.

| Field | What it is |
|-------|------------|
| **Base URL** | e.g. `https://lis.example.org` |
| **Auth Type** | `None`, `Bearer Token`, `Basic Auth`, or `API Key` |
| **Fetch Instruments Endpoint** | e.g. `/api/v1.1/instruments?labId=XYZ` |

**Fetch Instruments** tests the connection and retrieves the names. You can
always type them by hand instead.

## Result forwarding *(optional)*

Result forwarding sends every new result to one more system over HTTP, for
example an integration engine such as Open Integration Engine or Mirth Connect.
It does not change MySQL or InteLIS delivery. This section has its own
**Save forwarding** button. **Save Settings** does not save it.

| Field | What it is |
|-------|------------|
| **Forward results to this receiver** | Turns forwarding on or off. |
| **Receiver URL** | The address results are sent to, e.g. `http://localhost:8081/results`. |
| **Authentication** | `None`, `Bearer token`, `Basic (username and password)`, or `API key (X-API-Key header)`. |
| **Username** | For Basic authentication only. |
| **Bearer token**, **Password** or **API key** | The secret for the chosen authentication. After saving, leave it blank to keep the saved secret. |

**Send test** sends an empty test request with the values in the form. It sends
no results.

The first time you save this section, results already stored on this computer
are marked as not to be sent. This happens whether forwarding is on or off.
Results received after that first save are sent while forwarding is on. While
it is off, they are kept and sent once you turn it on. A result stays queued
until the receiver accepts it. **Waiting to send** shows how many are queued.

If you change the receiver URL to a different server, enter the secret again.
A saved secret is only ever sent to the server it was saved for.

A URL that uses plain `http://` to another computer shows a warning. Results and
credentials cross the network unencrypted on that URL.

Settings exports and backups do not include result forwarding. After restoring
on another computer, set it up again. The
[result webhook reference](../technical/result-webhook.md) describes the
request a receiver gets.

## Connecting to InteLIS

If your laboratory uses InteLIS, the **Connection Code** from your facility page
configures the laboratory, its instruments and the credentials in one step,
rather than filling in the sections above. Codes are single-use and expire.
