# How it is put together

An Electron application: a Node main process that owns the sockets and the
databases, and an Angular renderer that draws the console.

```
analyzer ──TCP──► main process ──► parsers ──► SQLite ──► MySQL / LIS API / result webhook
                       │                         │
                       └────── IPC ──────► Angular renderer (console, settings)
```

## The main process

`app/main.ts`. It owns everything with a handle attached to it:

- **TCP sockets**, in either direction. `tcpserver` listens for the analyzer;
  `tcpclient` dials it.
- **SQLite**, through `@vscode/sqlite3`, at `interface.db` in the data
  directory. Migrations in `app/sqlite-migrations/` are applied in order and
  recorded, so an installation from two years ago and a fresh one converge.
- **MySQL**, optionally, as the table an LIS on another machine reads.
- **Settings**, in `electron-store`, with automatic backups and encrypted
  export.

### The data directory is named, not derived

Electron puts `userData` under `app.getName()`, which is the product name. That
would mean renaming the product moved every laboratory's settings, database,
backups and migration history out from under it — silently, with an application
that opens looking brand new.

So `app/main.ts` names the directory instead, and names it what installations
have always used:

```ts
const DATA_DIRECTORY_NAME = 'vlsm-interfacing';
app.setPath('userData', path.join(app.getPath('appData'), DATA_DIRECTORY_NAME));
```

It runs before anything opens the store or the database, because both resolve
the path when they are constructed. `scripts/test-upgrade-identity.mjs` fails
the build if either of those two facts stops being true.

## The renderer

Angular, in `src/`. Services under `src/app/services/` do the protocol work:

| Service | Responsibility |
|---------|----------------|
| `instrument-interface.service.ts` | Owns each connection; routes bytes to the right helper; persists results |
| `astm-helper.service.ts` | E1381 framing, checksums, ACK/NAK, E1394 record extraction |
| `hl7-helper.service.ts` | MLLP block assembly, HL7 parsing, per-analyzer field mapping |
| `raw-data-processor.service.ts` | Re-derives results from stored raw transmissions |
| `database.service.ts` | SQLite and MySQL persistence, sync state |
| `utilities.service.ts` | Control-character handling, date formatting, logging |

### The renderer is privileged, and that is why the check exists

It runs with `nodeIntegration: true` and `contextIsolation: false`. Anything
that executes as script in it executes with full Node — the filesystem, the
network, the operator's machine.

That is safe today for exactly two reasons, and only those two:

1. Every value reaching the DOM goes through Angular interpolation, which
   escapes it. No analyzer or LIS text can become script.
2. The window only ever loads the bundled `file://` build. No remote content
   arrives in a privileged context.

Both are invisible in the code that depends on them. A single `[innerHTML]`
added to render a formatted result, or one remote URL opened in the window,
converts a rendering convenience into remote code execution — and whoever writes
that line has no reason to connect it to a `webPreferences` setting written
years earlier.

`scripts/check-electron-safety.mjs` makes that connection at the moment it
matters, failing the build on unescaped HTML sinks, remote window loads, second
web contexts, weakened `webPreferences`, and runtime code evaluation. A finding
that is genuinely safe is waived on the line, with a reason:

```ts
element.innerHTML = LEGAL_NOTICE; // electron-safety-ok: module constant, no input
```

A bare marker without a reason is still rejected. The check reads whole files
rather than single lines, because a call the formatter wrapped across two lines
is exactly the one nobody would notice.

## Testing at the level that matters

`src/app/testing/wire-harness.ts` feeds bytes into the real services through a
fake socket and a fake database, so a test asserts **from bytes in to rows out**.
A regression anywhere in framing, parsing or persistence shows up as a failing
test rather than as a wrong result in a laboratory.

`src/app/services/analyzer-captures.spec.ts` replays transmissions shaped
exactly like production captures. Those tests are the contract with the field:
a change that alters what a real analyzer's message stores has to fail there
first.
