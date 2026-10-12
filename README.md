# Talaria

Hands for Hermes on the device in front of you. Athena runs on one server. When she lists, reads,
writes or runs something, Talaria does it on a named device of yours (by default the one you are
talking to her from) and never on the server.

Named after Hermes' winged sandals. Status: **early testing.** Tried on a Mac (zsh) and Windows (PowerShell) device against one
backend, including one device reached from the other. Not for daily use yet.

## How it works

One installable Hermes plugin, `talaria/`, with two halves:

- **The agent half** (`talaria/__init__.py`, `talaria/core.py`) adds the tools `talaria_devices`,
  `talaria_list`, `talaria_read`, `talaria_write` and `talaria_run`, plus a `/talaria` command. It also
  keeps the device registry.
- **The device half** (`talaria/desktop/plugin.js`) is a stock Hermes Desktop plugin. It needs no
  modified app. It does the work through the app's own native bridge, so the app has to be open.

They talk through the plugin's routes on the dashboard (`/api/plugins/talaria/…`), which sit behind
the dashboard's login. Each device has its own Ed25519 key, and every call it makes is signed. The
server never broadcasts what to do, only "device X has a request". The device then fetches the request
and returns a signed result that names exactly the request it ran. See
[docs/protocol.md](docs/protocol.md).

**Folder rules are enforced on the device.** Each device has a list of allowed folders (Settings →
Plugins → Talaria). Anything outside them is refused there, whatever the server asks. An empty list
allows nothing.

**Which device.** Every tool takes an optional `device`. Without it, the target is the device where
this conversation was most recently focused or sent from. If there is none, for example a chat from a
phone, the call is refused and the online devices are listed. It never falls back to the server.

## Trying it on one machine

Hermes and Hermes Desktop running on the same PC is the simplest setup.

1. Copy the `talaria` folder into the `plugins` folder of your Hermes home (the folder that holds
   `config.yaml`). For development, link it instead so edits apply.
2. In `config.yaml`, add `talaria` under `plugins: enabled:`, then restart the Hermes backend.
3. In Hermes Desktop, open **Capabilities → Plugins** and turn on **Talaria**. Press **Rescan**
   first if it isn't listed. It ships switched off.
4. Open **Settings → Plugins → Talaria**. Pick a device name and list the folders Athena may use, one
   per line. The status line shows "Waiting for approval" with the device's key. In a chat, type the
   `/talaria approve …` line it shows. The status line then says "Online as …".
5. Ask Athena to call `talaria_devices`, then for example to list one of those folders.

**Every device must use the same backend.** Device presence lives in the backend's memory. A Desktop
that runs its own built-in backend reports to that one, and other devices see it as offline. On
the machine that hosts Hermes, point Desktop at the shared dashboard too (Settings → Gateways →
Remote gateway).

With a remote backend, Desktop cannot copy the device half from the server's disk. Copy
`talaria/desktop/plugin.js` into `<Hermes home>/desktop-plugins/talaria/` on each device (on
Windows `%LOCALAPPDATA%\hermes`, on a Mac `~/.hermes`), then press **Rescan** in Capabilities →
Plugins. Repeat after an update that changes `plugin.js`. **Install from Git** with the Desktop
target checked should also work, but has not been tried.

**Tell the agent to use it.** A capable model picks Talaria from the tool descriptions, but on the
machine that hosts Hermes the built-in file and terminal tools also reach the same disk and can
look right. One line in the agent's standing instructions settles it, for example: "Anything on my
own computers (files, folders, commands) goes through the talaria_* tools. The terminal and file
tools act only on the server."

## What is not done yet

- The first key to claim a name keeps it until `/talaria forget`. A new key waits for approval:
  the device's status line shows its key, and you type `/talaria approve <name> <key>` in a chat.
  Approval happens only through that command, never through a tool, so the agent cannot approve.
- If a device is lost, `/talaria revoke <name>` refuses its key from then on and frees its name. The
  lost device also holds the dashboard login, so change the dashboard password too.
- The private key is kept in the plugin's storage in the app, not in the OS keychain.
- Write and run cannot detect a symlink that leads out of an allowed folder. List and read check the
  resolved path.
- Commands run in the device's own shell: zsh/bash/sh/fish, or PowerShell on Windows. `cmd.exe` is
  refused. A command that reads from the terminal will wait until its timeout.
- Hermes' own `terminal` and file tools are not rerouted yet; Talaria has its own tools.
- Not supported: `dashboard.turn_isolation`, `plugins.isolation: host`, and Desktop connected to its
  backend over SSH (refused, since its terminal would run on the server).
- No standalone helper yet, so the app has to be open.
- One person. Hermes has no user accounts, so any chat can name any device. If that changes, the
  likely path is one Hermes profile per person, each with its own device list. Today every profile
  served by one backend shares one list.

## Layout

```
talaria/                 the plugin (install this folder)
  plugin.yaml
  __init__.py            tools and /talaria
  core.py                devices, signatures, broker
  dashboard/             routes under /api/plugins/talaria/
  desktop/plugin.js      the device half
  tests/                 pytest (Python) and node:test (JS)
docs/protocol.md
```

Tests: `python -m pytest talaria/tests` (needs Hermes' Python environment for `cryptography`), and
`node --import ./talaria/tests/js/register.mjs --test talaria/tests/js/plugin.test.mjs`.

## License

MIT. See [LICENSE](LICENSE).
