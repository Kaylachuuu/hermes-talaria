# Talaria

Hands for Hermes on the device in front of you. Athena runs on one server. When she lists, reads,
writes or runs something, Talaria does it on a named device of yours (by default the one you are
talking to her from) and never on the server.

Named after Hermes' winged sandals. Status: **first one-device test**, not for daily use yet.

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
   per line. The status line should say "Online as …".
5. Ask Athena to call `talaria_devices`, then for example to list one of those folders.

With a remote backend, the device half is installed per device through **Install from Git** with
the Desktop target checked. That path has not been tried yet.

## What is not done yet

- Enrollment is trust on first use: the first key to claim a name keeps it until `/talaria forget`.
  An approval step on the device comes later.
- The private key is kept in the plugin's storage in the app, not in the OS keychain.
- Write and run cannot detect a symlink that leads out of an allowed folder. List and read check the
  resolved path.
- Commands run in the device's own shell: zsh/bash/sh/fish, or PowerShell on Windows. `cmd.exe` is
  refused. A command that reads from the terminal will wait until its timeout.
- Hermes' own `terminal` and file tools are not rerouted yet; Talaria has its own tools.
- Not supported: `dashboard.turn_isolation`, `plugins.isolation: host`, and Desktop connected to its
  backend over SSH (refused, since its terminal would run on the server).
- No standalone helper yet, so the app has to be open.

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
