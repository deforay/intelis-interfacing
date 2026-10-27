# Troubleshooting

Work down the chain: is the analyzer connected, is it sending, is the tool
storing, is the LIS taking.

## The analyzer will not connect

**In TCP Server mode** the tool waits and the analyzer dials in. The log should
say `Server bound and listening on <address>:<port>` shortly after you press
**Start Server**. If it does not:

- The address must be one this machine actually has. `127.0.0.1` only accepts
  connections from the same machine, which is not what you want when the
  analyzer is a separate box on the network.
- Something else may already hold the port. Two instruments configured on the
  same port is the usual cause. A second copy of the tool left running is
  another.
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

- **Truncated results, or a result with odd characters in it**: this was a
  defect in versions before 4.2.0 affecting analyzers that split records across
  frames, the Cepheid GeneXpert in particular. Upgrade. Nothing is lost: the raw
  transmissions were stored intact, and reprocessing them recovers the results.
  See [raw data and recovery](raw-data.md), including what reprocessing does to
  results the LIS has already taken.
- **A result that looks like a foreign number**: `1420403,41` is a French
  analyzer's way of writing 1420403.41. It is stored as sent, deliberately. See
  [why](console.md#received-results).
- **An empty result with an error note**: the analyzer reported a failed run.
  The note carries its explanation.

## Results are not reaching the LIS

- The **Synced to LIS** column shows whether the LIS has each result. `Could
  not sync` means the LIS did not take the result. It does not mean the test
  failed. Select those results and press **Re-sync Selected** to send
  them again.
- If every result shows `Not yet`, the LIS is not taking them: check the MySQL
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

## The tool says a restart is required

The tool repairs its own database without a message. When a repair is not
enough, the tool comes to the front, shows **Restart required** on every
screen, and counts down from 30 seconds. Stored results and settings are kept.

- Press **Restart Now** to restart sooner. The restart cannot be put off.
- If an analyzer is sending when the count ends, the tool waits for it to
  finish, for up to two minutes.
- After the restart, a small window says **Finishing the update** until the
  tool opens.

If the problem comes back within ten minutes of that restart, the tool shows
**Database Needs Attention** and does not restart again. Contact support and
send the [log files](#where-the-log-files-are).

If results stop saving and no notice appears, open
**Settings → Troubleshooting** and press **Repair and Restart**.

## Where the log files are

Open **Settings → Troubleshooting** and press **Open Logs Folder**. Each log
file is named by the date the tool started.

If the tool does not open, find the folder beside the database, in the tool's
data directory:

| Platform | Location |
|----------|----------|
| Windows | `%APPDATA%\vlsm-interfacing\logs` |
| Linux | `~/.config/vlsm-interfacing/logs` |
| macOS | `~/Library/Application Support/vlsm-interfacing/logs` |

!!! note "The folder name is the old one, and that is deliberate"

    The application was renamed. The data directory was not. Moving it would
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
- for a wrong result, the raw transmission from **View Raw Data**, with sample
  identifiers and patient details removed
