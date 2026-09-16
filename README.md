# InteLIS Interfacing

![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue)

A standalone Electron application that receives test results from laboratory
analyzers and stores them where a laboratory information system can pick them
up. It is deliberately **LIS-agnostic**: results land in a local SQLite database
and, optionally, a MySQL database any information system can read.

**📖 [Documentation](https://deforay.github.io/intelis-interfacing/)** — [user
guide](https://deforay.github.io/intelis-interfacing/guide/) for setting it up
and running it, [technical
guide](https://deforay.github.io/intelis-interfacing/technical/) for the
protocols, the storage, and the rules a change is held to.

## How it works

1. Analyzers connect to this tool over TCP, or are connected to.
2. It reads their transmissions — ASTM E1394 records inside E1381 frames, with
   or without checksums, or HL7 v2 inside MLLP blocks.
3. Each result is stored exactly as the analyzer reported it, alongside the raw
   transmission it came from.
4. The LIS reads results from MySQL, or the tool pushes them to an API.
   Optionally, every result is also forwarded as JSON to any HTTP receiver,
   such as an integration engine.

Supported: Roche cobas Taqman, 4800, 5800 and 6800/8800; Abbott m2000 and
Alinity m; Cepheid GeneXpert; and generic ASTM and HL7 for anything else that
speaks them.

## Install

```bash
# Debian and Ubuntu
curl -fsSL https://raw.githubusercontent.com/deforay/intelis-interfacing/master/scripts/install.sh | bash
```

Windows installers are on the
[releases page](https://github.com/deforay/intelis-interfacing/releases). Full
instructions, including what happens when you upgrade, are in the
[installation guide](https://deforay.github.io/intelis-interfacing/guide/install/).

> Previously released as **vlsm-interfacing**. Upgrading keeps everything —
> settings, results, raw transmissions and backups stay in the same folder they
> have always been in.

## Build from source

```bash
git clone https://github.com/deforay/intelis-interfacing.git
cd intelis-interfacing
npm install

npm start               # development
npm run electron:build  # production build into release/
npm run verify          # the gate: safety check, lint, tests, production build
```

See [building and
releasing](https://deforay.github.io/intelis-interfacing/technical/building/)
for what the gate covers and how a release is cut.

## Funding and partners

InteLIS Interfacing is developed with funding from the United States Government
(USG). Over the years, the project has benefited from the support and
collaboration of partners including the African Society for Laboratory Medicine
(ASLM), the American Society for Microbiology (ASM), the African Field
Epidemiology Network (AFENET), Emory University, and the Maryland Global
Initiatives Corporation (MGIC), among others.

## License

Free and open-source software released under the **GNU Affero General Public
License v3.0 (AGPL-3.0)**. Read the full text in [LICENSE.md](LICENSE.md).

## Support

For issues, questions or feature requests, open an issue on
[GitHub](https://github.com/deforay/intelis-interfacing/issues).
