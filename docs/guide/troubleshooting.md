# When something is wrong

Work down the chain: is the analyzer connected, is it sending, is the tool
storing, is the LIS taking.

## The analyzer will not connect

**In TCP Server mode** the tool waits and the analyzer dials in. The log should
say `Server bound and listening on <address>:<port>` shortly after you press
Connect. If it does not:

- The address must be one this machine actually has. `127.0.0.1` only accepts
  connections from the same machine, which is not what you want when the
  analyzer is a separate box on the network.
- Something else may already hold the port. Two instruments configured on the
  same port is the usual cause; so is a second copy of the tool left running.
- A firewall between the analyzer and this machine has to allow the port.

**In TCP Client mode** the tool dials the analyzer, so the analyzer has to be
listening and reachable. Confirm the address and port on the analyzer's own
configuration screen.

## It connects, but no results arrive

- Results only arrive **while the connection shows as connected**. Check the tab.
- The analyzer usually has to be told where to send results, and often has a
  separate "transmit" or "host query" setting that has to be enabled.
- Watch the log while you re-send a result from the analyzer. `Receiving....`
  means the transmission reached the tool, and the problem is after that point.
  Nothing at all means it did not.

## Results arrive but look wrong

- **Truncated results, or a result with odd characters in it** — this was a
  defect in versions before 4.2.0 affecting analyzers that split records across
  frames, the Cepheid GeneXpert in particular. Upgrade. Nothing is lost: the raw
  transmissions were stored intact, and reprocessing them recovers the results —
  see [raw data and recovery](raw-data.md), including what reprocessing does to
  results the LIS has already taken.
- **A result that looks like a foreign number** — `1420403,41` is a French
  analyzer's way of writing 1420403.41. It is stored as sent, deliberately. See
  [why](console.md#received-results).
- **An empty result with an error note** — the analyzer reported a failed run.
  The note carries its explanation.

## Results are not reaching the LIS

- The **Sync Status** column says which stage a result is at. `Failed` results
  can be selected and re-synced.
- If every result is `Pending`, the LIS is not taking them: check the MySQL
  settings with **Test Connection**, or the LIS API configuration.
- **Last Results Synced to LIS** on the console tells you when it last worked,
  which usually locates the change that broke it.

## Results are not reaching the forwarding receiver

- **Settings → Result Forwarding** shows the status, the number of results
  waiting to send, and the last error from the receiver.
- **Send test** checks the URL and credentials without sending results.
- A result counts as sent only when the receiver answers with a `2xx` status.
  Any other answer keeps the result queued, and the tool retries automatically.
- If **Waiting to send** does not reach zero, the receiver may be refusing one
  particular result. The other results still go through. The log records the
  receiver's answer, for example `http_422`.
- Results already stored when the section was first saved are never sent.

## Where the log files are

Log files sit beside the database, in the tool's data directory:

| Platform | Location |
|----------|----------|
| Windows | `%APPDATA%\vlsm-interfacing\logs` |
| Linux | `~/.config/vlsm-interfacing/logs` |
| macOS | `~/Library/Application Support/vlsm-interfacing/logs` |

!!! note "The folder name is the old one, and that is deliberate"

    The application was renamed; the data directory was not. Moving it would
    have meant every existing installation starting empty on the day it
    upgraded. See [Upgrading from vlsm-interfacing](install.md#upgrading-from-vlsm-interfacing).

## Reporting a problem

Open an issue at
[github.com/deforay/intelis-interfacing/issues](https://github.com/deforay/intelis-interfacing/issues)
with:

- what you expected and what happened
- the version, from the bottom of the console
- the analyzer model and the protocol it is configured for
- the relevant part of the connection log
- for a wrong result, the raw transmission from **View Raw Data** — with sample
  identifiers and patient details removed
