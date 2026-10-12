# Talaria protocol, version `talaria/1`

Between the Talaria plugin on the Hermes server and each device. All device calls are HTTPS
`POST`s to the plugin's routes under `/api/plugins/talaria/` on the dashboard, so they also need the
dashboard's own login.

## Identity

Each device generates an Ed25519 key pair once. Its **device id** is the first 16 bytes of
SHA-256 over the raw 32-byte public key, written as 32 hex characters. Its **name** is chosen on the device
(lowercase letters, digits and dashes, up to 32 characters).

The server binds a name to the first key that claims it and keeps the binding in
`$HERMES_HOME/talaria/devices.json`. `/talaria forget <name>` releases it. A new key is enrolled as
unapproved: it may say hello, but the server sends it no work and does not offer it as a default until
the user types `/talaria approve <name> [key fingerprint]`. Devices enrolled before approval existed
are treated as approved.

## Envelopes

Every device call has this body:

```json
{"v": 1, "kind": "hello|claim|result", "device_id": "…", "ts": 1760000000000,
 "nonce": "24 hex chars", "payload": "<JSON text>", "sig": "<base64>",
 "public_key": "<base64, hello only>"}
```

`sig` is the Ed25519 signature over these lines joined with `\n`:

```
talaria/1
<kind>
<device_id>
<ts>
<nonce>
<hex SHA-256 of the UTF-8 payload text>
```

The server refuses an envelope if any of these hold: its `ts` is more than 120 seconds off; the nonce
was already used by that device; the signature does not verify against the enrolled key, or (for a
first `hello`) against the included key whose hash must equal `device_id`.

## Calls

- **`hello`**, every 5 seconds and whenever focus changes. Payload: `name`, `platform`, `shell`,
  `roots` (allowed folders, for display only; the device enforces them), and `sessions`, a list of
  `{session_id, at}` giving when a chat was last focused or sent from on this device. The reply is
  `{device_id, name, approved, pending: [request ids]}`. A device counts as online for 150 seconds after a hello: when the app window is hidden and idle,
  Chromium throttles its timers to about once a minute, while the request event still arrives at once.
- **`claim`** `{request_id}`. Returns `{request_id, op, args, timeout, digest}` once, and only to the
  target device.
- **`result`** `{request_id, digest, ok, result | error}`. `digest` must equal the claimed one, which
  is SHA-256 over the canonical JSON of `{"id", "op", "args"}` (keys sorted, no spaces).

## Server to device

The server sends two events on the app's event stream: `plugin.talaria.request` and
`plugin.talaria.cancel`. Each carries only `{request_id, device_id}`. Every connected client receives
them, which is why they carry nothing else. A device that misses the event finds the request in its
next `hello` reply.

The server gives up if a request is not claimed within 12 seconds, so nothing has run. It also gives
up if no result arrives within the request's timeout plus 5 seconds; it then sends `cancel`, and the
device stops the command.

## Operations

| op | args | result |
|---|---|---|
| `list` | `path` | `{path, entries: [{name, type}], truncated}` |
| `read` | `path` | `{path, text, size, truncated}` (text files up to 512 KB) |
| `write` | `path, content` | `{path, written}` (up to 1,000,000 characters; folder must exist) |
| `run` | `command, cwd, timeout` | `{exit_code, output, shell, timed_out}` |

Paths are absolute paths on the device. Before doing anything, the device checks them against its
allowed folders after normalising `.` and `..`. Windows paths are compared case-insensitively.
