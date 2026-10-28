# User guide

This guide is for the person who sets the tool up on a laboratory machine and
the people who use it every day. It assumes nothing about programming.

If you are installing for the first time, read in order:

1. **[Install](install.md)**: getting the application onto the machine, and
   what happens to an existing installation when you upgrade.
2. **[Settings](settings.md)**: the laboratory, the database, and the
   instruments the tool will listen to.
3. **[Console](console.md)**: connecting an instrument and watching results
   arrive.
4. **[Raw data and recovery](raw-data.md)**: what the tool keeps of every
   transmission, and how to recover results it once read wrongly.
5. **[Backup and restore](backup-restore.md)**: keeping a copy of the
   configuration, and moving it to another machine.
6. **[Troubleshooting](troubleshooting.md)**: what the messages mean
   and what to do about them.

## Quick reference

| Action | Where |
|--------|-------|
| Change settings | Console → **Settings** (top right) |
| View raw data | Console → **View Raw Data** (bottom left) |
| View dashboard | Console → **Dashboard** (top right) |
| Export settings | Settings → **Backup & Restore** → **Export Settings** |
| Import settings | Settings → **Backup & Restore** → **Import Settings** |
| Change backup schedule | Settings → **Backup & Restore** → **Automatic Backup** |
| Find saved backups | Settings → **Backup & Restore** → **Open Backup Folder** |

## Signing in

The application opens on a login screen.

- **Login ID:** `admin`
- **Password:** `admin`

On the first sign-in you are taken straight to Settings, because there is
nothing to show on the console until an instrument is configured.

!!! tip "Skipping the login"

    **Skip Sign-in and Connect at Startup** in [system settings](settings.md#system) skips
    the login screen and connects every instrument as soon as the application
    opens. On a dedicated machine beside the analyzer, that is usually what you
    want: if the computer opens the tool at startup, the tool is listening
    before anyone thinks about it.
