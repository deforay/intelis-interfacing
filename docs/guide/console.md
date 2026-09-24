# The console

The console is where you connect instruments and watch results arrive.

## Instrument connections

Each configured instrument is a tab across the top, showing:

- **Connection status** — connected, or not
- **Connection details** — model, mode, address, protocol
- **Connection logs** — what is happening on the wire, as it happens

To connect: if **Auto-connect** is on, the tool connects everything at startup.
If it is off, sign in and press **Connect** on each tab.

!!! warning "Results only arrive while an instrument shows as connected"

    An analyzer that finishes a run while the tool is disconnected does not
    normally queue the result and send it later. Most will report the
    transmission as failed and leave the result to be re-sent by hand from the
    analyzer's own screen.

### Connection logs

The log is the first place to look when something is not working, and it is
written to be read by someone who is not a programmer. Lines you will see
regularly:

| Line | What it means |
|------|---------------|
| `Server bound and listening on <address>:<port>` | The tool is ready and waiting for the analyzer to connect. |
| `Client <address> has connected` | The analyzer opened a connection. |
| `Receiving....` followed by record text | A transmission is arriving. |
| `Sending ACK` | The tool acknowledged what it received, as the protocol requires. |
| `Successfully saved result : <sample>` | A result was stored. |
| `Client <address> disconnected normally` | The analyzer closed the connection, which it does between runs. |

## Received results

Below the tabs, every result the tool has stored:

| Column | What it is |
|--------|------------|
| **Instrument** | Which analyzer sent it |
| **Sample ID** | The sample identifier, as the analyzer sent it |
| **Result** | The result, as the analyzer sent it |
| **Unit** | The unit, as the analyzer sent it |
| **Test Type** | The assay |
| **Tested By** | The operator recorded by the analyzer |
| **Tested On** | When the analyzer ran the test |
| **Received On** | When this tool received it |
| **Sync Status** | `Pending`, `Synced` or `Failed` |

You can search by instrument, sample ID or test type, re-sync results that
failed, and refresh the list.

!!! info "Why a result can look odd"

    Results are stored exactly as the analyzer reported them. An analyzer set to
    French sends `NON DÉTECTÉ` and writes numbers with a decimal comma
    (`1420403,41`); an Abbott m2000 sends `< 40`; a Roche 6800 sends a mantissa
    with a power-of-ten unit. None of that is corrected on the way in, because
    correcting it would mean guessing, and a guess about a viral load is not
    something a laboratory can check afterwards. If the LIS needs another form,
    that conversion belongs in the LIS.

## Quick stats

Two timestamps at the bottom:

- **Last Results Synced to LIS** — when the LIS last took results
- **Last Result From Instrument** — when an analyzer last sent one

They answer different questions. Results arriving but not syncing is a problem
between the tool and the LIS; nothing arriving at all is a problem between the
analyzer and the tool.

## Raw data

**View Raw Data** shows the transmissions themselves, as received. It is the
record of what the analyzer actually said, kept so that a result can be
re-derived if the tool ever read one wrongly — see
[raw data and recovery](raw-data.md). When reporting a problem with a result,
this is the useful thing to send.

**Show original data**, the file icon at the end of a result's row, shows two
things: the result's own records, and the whole transmission they arrived in.
