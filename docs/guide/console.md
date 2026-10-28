# Console

The console is where you connect instruments and watch results arrive.

## Instrument connections

Each configured instrument is a tab across the top, showing:

- **Connection status**: connected, or not
- **Connection details**: machine type, connection mode, address, protocol
- **Connection logs**: what is happening on the wire, as it happens

To connect: if **Skip Sign-in and Connect at Startup** is on, the tool connects everything
at startup. If it is off, sign in and press **Connect** on each tab. For a TCP
server the button reads **Start Server**.

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
| `Server bound and listening on <address>:<port>. Waiting for a client to connect…` | The tool is ready and waiting for the analyzer to connect. |
| `Client <address> has connected to the Interfacing Server <address>:<port>` | The analyzer opened a connection. |
| The protocol name, `Receiving....` and the record text (ASTM), or `Receiving HL7 data` | A transmission is arriving. |
| `Sending ACK` (ASTM), or `Sent HL7 ACK for message:` and the message ID | The tool acknowledged what it received, as the protocol requires. |
| `Successfully saved result :` followed by the test and sample IDs | A result was stored. |
| `Client <address>:<port> disconnected normally` | The analyzer closed the connection, which it does between runs. |

## Received results

Below the tabs, the 1,000 most recent results the tool has stored, newest
first:

| Column | What it is |
|--------|------------|
| **Instrument** | Which analyzer sent it. The test type is below it. |
| **Sample ID** | The sample identifier, as the analyzer sent it |
| **Result** | The result as stored, followed by its unit. The result is as the analyzer sent it, unless a [result rule](settings.md#result-rules) replaced it. |
| **Tested On** | When the analyzer ran the test. The operator the analyzer recorded is below it. |
| **Received On** | When this tool received it |
| **Result Status** | What the analyzer said about the result: `Final`, `Corrected`, `Preliminary`, `Incomplete`, `Cannot be done` or `Failed`. A dash means the analyzer status is not known for a result captured before 4.8.4. |
| **Synced to LIS** | `Yes` when the LIS has the result. `Not yet` while the result waits. `Could not sync` when the LIS did not take it. Hover over the value to see when the LIS answered. None of these values describes the test. |

You can search by instrument, sample ID or test type, select results and press
**Re-sync Selected** to send them to the LIS again, and press **Refresh** to
reload the list. A **Notes** column appears when a listed result has notes.

!!! info "Why a result can look odd"

    Results are stored exactly as the analyzer reported them, unless a result
    rule replaces them. An analyzer set to French sends `NON DÉTECTÉ` and writes
    numbers with a decimal comma (`1420403,41`). An Abbott m2000 sends `< 40`. A
    Roche 6800 sends a mantissa with a power-of-ten unit. None of that is corrected on the way in, because
    correcting it would mean guessing, and a guess about a viral load is not
    something a laboratory can check afterwards. If the LIS needs another form,
    that conversion belongs in the LIS.

## Quick stats

Two timestamps between the instrument tabs and the results:

- **Last Results Synced to LIS**: when the LIS last took results
- **Last Result From Instrument**: when an analyzer last sent one

They answer different questions. Results arriving but not syncing is a problem
between the tool and the LIS. Nothing arriving at all is a problem between the
analyzer and the tool.

## Raw data

**View Raw Data** shows the transmissions themselves, as received. It is the
record of what the analyzer actually said, kept so that a result can be
re-derived if the tool ever read one wrongly. See
[raw data and recovery](raw-data.md). When reporting a problem with a result,
this is the useful thing to send.

**Show original data**, the file icon at the end of a result's row, shows two
things: the result's own records, and the whole transmission they arrived in.
