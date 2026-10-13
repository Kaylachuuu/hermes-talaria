"""Talaria core: enrolled devices, signed envelopes, presence, and the request broker.

Pure Python with no Hermes imports, so it can be tested on its own. The plugin's agent half
(``__init__.py``) and its dashboard routes (``dashboard/plugin_api.py``) are imported by Hermes as
two unrelated modules; both reach this one through :func:`shared`, so they share a single broker.

Wire protocol (see docs/protocol.md): every call a device makes carries an envelope signed with its
Ed25519 key. The server never broadcasts a request's contents, only a nudge naming the request id
and the target device. The device then claims the request with a signed call and posts a signed
result that names the digest of the request it ran.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import secrets
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

PROTOCOL = "talaria/1"
#: A signed envelope older or newer than this is refused.
CLOCK_SKEW_MS = 120_000
#: A device that has not said hello for this long is offline.
# Devices say hello every 5s, but once the app window is hidden or minimized and idle, Chromium
# throttles its timers to as little as once a minute. Requests still reach a hidden window at once
# through the event stream, so presence has to outlast that throttling rather than the 5s cadence.
ONLINE_WINDOW_S = 150.0
#: How long a device has to pick up a request before the tool call fails.
CLAIM_TIMEOUT_S = 12.0
#: Extra time after a command's own timeout before the server gives up on the result.
RESULT_GRACE_S = 5.0
MAX_RUN_TIMEOUT_S = 120
OPS = ("list", "read", "write", "run", "browser", "screen")
# Operations a device does only when it says it can (the background helper, switched on there).
ABILITY_OPS = {"browser": "browser", "screen": "screen"}
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


class TalariaError(Exception):
    """A refusal or failure reported to the model as a tool result. Never retried elsewhere."""


class EnvelopeError(TalariaError):
    """A device call whose signature, freshness or identity does not check out."""


# --------------------------------------------------------------------------- signing

def b64d(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def b64e(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def device_id_for(public_key: bytes) -> str:
    """A device's id is the first 16 bytes of the SHA-256 of its raw public key, in hex."""
    return hashlib.sha256(public_key).hexdigest()[:32]


def signing_message(kind: str, device_id: str, ts: int, nonce: str, payload: str) -> bytes:
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return "\n".join((PROTOCOL, kind, device_id, str(ts), nonce, digest)).encode("utf-8")


def request_digest(request_id: str, op: str, args: dict) -> str:
    """The digest a result must name, binding it to exactly the request the device was given."""
    canonical = json.dumps({"id": request_id, "op": op, "args": args}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _verify(public_key: bytes, signature: bytes, message: bytes) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


# --------------------------------------------------------------------------- devices

def _edit_distance(a: str, b: str) -> int:
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1]


@dataclass
class Device:
    device_id: str
    name: str
    public_key: str  # base64 raw Ed25519 key
    enrolled_at: float
    # A new key waits for the user's `/talaria approve <name>` before it is sent any work.
    approved: bool = False
    # Presence, never persisted.
    last_seen: float = 0.0
    platform: str = ""
    shell: str = ""
    roots: list = field(default_factory=list)
    abilities: list = field(default_factory=lambda: ["files"])
    # Runtime session id -> the last time this device showed it focused or sent a message in it.
    sessions: dict = field(default_factory=dict)

    def online(self, now: float) -> bool:
        return now - self.last_seen < ONLINE_WINDOW_S

    def usable(self, now: float) -> bool:
        return self.approved and self.online(now)

    def public(self, now: float) -> dict:
        return {"name": self.name, "device_id": self.device_id, "online": self.online(now),
                "approved": self.approved, "platform": self.platform, "shell": self.shell,
                "allowed_folders": list(self.roots), "fingerprint": self.device_id[:8],
                "can": list(self.abilities)}


class DeviceStore:
    """Enrolled devices, persisted as JSON. Presence lives in memory only."""

    def __init__(self, path: Optional[Path]):
        self.path = path
        self._lock = threading.RLock()
        self._devices: dict[str, Device] = {}
        # Keys of lost or stolen devices: refused for good, even if they say hello again.
        self._revoked: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        data = json.loads(self.path.read_text(encoding="utf-8") or "{}")
        for row in data.get("devices", []):
            # Rows from before approval existed were trusted on first use; keep them working.
            device = Device(row["device_id"], row["name"], row["public_key"], row["enrolled_at"],
                            approved=bool(row.get("approved", True)))
            self._devices[device.device_id] = device
        for row in data.get("revoked", []):
            self._revoked[row["device_id"]] = row

    def _save(self) -> None:
        if self.path is None:
            return
        rows = [{"device_id": d.device_id, "name": d.name, "public_key": d.public_key,
                 "enrolled_at": d.enrolled_at, "approved": d.approved} for d in self._devices.values()]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"devices": rows, "revoked": list(self._revoked.values())}, indent=2),
                       encoding="utf-8")
        os.replace(tmp, self.path)

    def get(self, device_id: str) -> Optional[Device]:
        with self._lock:
            return self._devices.get(device_id)

    def by_name(self, name: str) -> Optional[Device]:
        """The approved device with this name, else the newest key waiting for it."""
        named = self.named(name)
        approved = [d for d in named if d.approved]
        if approved:
            return approved[0]
        return max(named, key=lambda d: d.enrolled_at) if named else None

    def named(self, name: str) -> list[Device]:
        key = name.strip().lower()
        with self._lock:
            return [d for d in self._devices.values() if d.name == key]

    def all(self) -> list[Device]:
        with self._lock:
            return sorted(self._devices.values(), key=lambda d: d.name)

    def enroll(self, public_key: str, name: str, now: float) -> Device:
        """A name is bound to the first key that claims it, until forgotten. A new key starts out
        unapproved: it can say hello, but is sent no work until the user approves it."""
        name = name.strip().lower()
        if not _NAME_RE.match(name):
            raise EnvelopeError("device name must be 1-32 lowercase letters, digits or dashes")
        device_id = device_id_for(b64d(public_key))
        with self._lock:
            existing = self._devices.get(device_id)
            if existing is not None:
                if existing.name != name:
                    taken = self.by_name(name)
                    if taken is not None and taken.device_id != device_id:
                        raise EnvelopeError(f"the name {name!r} belongs to another device")
                    existing.name = name
                    self._save()
                return existing
            # A new key may ask for a name that is already taken, e.g. the background helper taking
            # over from the Desktop app. It waits unapproved; approving it with its key replaces the
            # old holder (approve()). Until then the old holder keeps the name.
            device = Device(device_id, name, public_key, now)
            self._devices[device_id] = device
            self._save()
            return device

    def approve(self, name: str, fingerprint: str = "") -> tuple[Device, Optional[Device]]:
        """Approve a waiting key for a name; returns (approved, replaced). With a fingerprint, the
        key must match the one shown on the device. Replacing an approved device's key, or choosing
        between several waiting keys, needs the fingerprint."""
        fingerprint = fingerprint.strip().lower()
        with self._lock:
            named = self.named(name)
            if not named:
                raise TalariaError(f"no device named {name!r}")
            holder = next((d for d in named if d.approved), None)
            waiting = [d for d in named if not d.approved]
            if fingerprint:
                if holder is not None and holder.device_id.startswith(fingerprint):
                    return holder, None
                match = [d for d in waiting if d.device_id.startswith(fingerprint)]
                if not match:
                    keys = ", ".join(d.device_id[:8] for d in waiting) or "none"
                    raise TalariaError(f"no key {fingerprint} is waiting for {name!r} (waiting: {keys}); "
                                       "not approved")
                device = match[0]
            else:
                if not waiting:
                    return holder, None
                if holder is not None or len(waiting) > 1:
                    raise TalariaError(f"to give {name!r} to a new key, name the key shown on that "
                                       f"device: /talaria approve {name} <key>")
                device = waiting[0]
            device.approved = True
            if holder is not None:
                del self._devices[holder.device_id]
            self._save()
            return device, holder

    def is_revoked(self, device_id: str) -> bool:
        with self._lock:
            return device_id in self._revoked

    def revoke(self, name: str, now: float) -> Device:
        """Remove a lost device and refuse its key from now on. Its name is free for a new device."""
        with self._lock:
            device = self.by_name(name)
            if device is None:
                raise TalariaError(f"no device named {name!r}")
            del self._devices[device.device_id]
            self._revoked[device.device_id] = {"device_id": device.device_id, "name": device.name,
                                               "revoked_at": now}
            self._save()
            return device

    def forget(self, name: str) -> bool:
        """Remove every key holding or waiting for this name."""
        with self._lock:
            named = self.named(name)
            for device in named:
                del self._devices[device.device_id]
            if named:
                self._save()
            return bool(named)


# --------------------------------------------------------------------------- broker

@dataclass
class Pending:
    request_id: str
    device_id: str
    op: str
    args: dict
    timeout: float
    created: float
    digest: str
    event: threading.Event = field(default_factory=threading.Event)
    claimed: bool = False
    done: bool = False
    ok: bool = False
    result: Any = None


class Talaria:
    """Devices, presence and in-flight requests for one Hermes process."""

    def __init__(self, store: DeviceStore, *, notify: Optional[Callable[[str, dict], None]] = None,
                 clock: Callable[[], float] = time.time):
        self.store = store
        self.notify = notify or (lambda event, payload: None)
        self.clock = clock
        self._lock = threading.RLock()
        self._pending: dict[str, Pending] = {}
        self._nonces: dict[str, float] = {}

    # -- envelopes ---------------------------------------------------------------------------

    def open_envelope(self, envelope: Any, kind: str) -> tuple[Device, dict]:
        """Verify a device's signed call and return the device and its decoded payload.

        A ``hello`` from an unknown key enrolls it (trust on first use, by name). Every other call
        must come from an enrolled device.
        """
        if not isinstance(envelope, dict) or envelope.get("v") != 1 or envelope.get("kind") != kind:
            raise EnvelopeError("not a talaria/1 envelope of the expected kind")
        try:
            device_id = str(envelope["device_id"])
            ts = int(envelope["ts"])
            nonce = str(envelope["nonce"])
            payload_text = envelope["payload"]
            signature = b64d(str(envelope["sig"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise EnvelopeError(f"malformed envelope: {exc}") from None
        if not isinstance(payload_text, str) or not 8 <= len(nonce) <= 64:
            raise EnvelopeError("malformed envelope")
        now = self.clock()
        if abs(now * 1000 - ts) > CLOCK_SKEW_MS:
            raise EnvelopeError("envelope is stale or from the future; check the device clock")
        if self.store.is_revoked(device_id):
            raise EnvelopeError("this device was revoked")
        device = self.store.get(device_id)
        if device is not None:
            public_key = b64d(device.public_key)
        elif kind == "hello" and isinstance(envelope.get("public_key"), str):
            public_key = b64d(envelope["public_key"])
            if device_id_for(public_key) != device_id:
                raise EnvelopeError("device id does not match its public key")
        else:
            raise EnvelopeError("unknown device; it has to say hello first")
        if not _verify(public_key, signature, signing_message(kind, device_id, ts, nonce, payload_text)):
            raise EnvelopeError("bad signature")
        with self._lock:
            cutoff = now - 2 * CLOCK_SKEW_MS / 1000
            for key, seen in list(self._nonces.items()):
                if seen < cutoff:
                    del self._nonces[key]
            replay_key = f"{device_id}:{nonce}"
            if replay_key in self._nonces:
                raise EnvelopeError("replayed envelope")
            self._nonces[replay_key] = now
        try:
            payload = json.loads(payload_text)
        except ValueError:
            raise EnvelopeError("payload is not JSON") from None
        if not isinstance(payload, dict):
            raise EnvelopeError("payload is not an object")
        if device is None:
            device = self.store.enroll(b64e(public_key), str(payload.get("name") or ""), now)
        return device, payload

    # -- device calls ------------------------------------------------------------------------

    def hello(self, envelope: Any) -> dict:
        device, payload = self.open_envelope(envelope, "hello")
        now = self.clock()
        name = str(payload.get("name") or device.name)
        if name.strip().lower() != device.name:
            device = self.store.enroll(device.public_key, name, now)
        device.last_seen = now
        device.platform = str(payload.get("platform") or "")[:40]
        device.shell = str(payload.get("shell") or "")[:40]
        abilities = payload.get("abilities")
        device.abilities = ([str(a)[:20] for a in abilities[:8]] if isinstance(abilities, list)
                            else ["files"])
        roots = payload.get("roots")
        device.roots = [str(r)[:400] for r in roots[:32]] if isinstance(roots, list) else []
        for claim in payload.get("sessions") or []:
            if isinstance(claim, dict) and claim.get("session_id"):
                try:
                    at = float(claim.get("at") or 0) / 1000.0
                except (TypeError, ValueError):
                    continue
                sid = str(claim["session_id"])[:128]
                if at > device.sessions.get(sid, 0) and at <= now + 5:
                    device.sessions[sid] = at
        if len(device.sessions) > 64:
            for sid in sorted(device.sessions, key=device.sessions.get)[:-64]:
                del device.sessions[sid]
        with self._lock:
            waiting = [p.request_id for p in self._pending.values()
                       if p.device_id == device.device_id and not p.claimed and not p.done]
        return {"device_id": device.device_id, "name": device.name, "approved": device.approved,
                "pending": waiting}

    def claim(self, envelope: Any) -> dict:
        device, payload = self.open_envelope(envelope, "claim")
        request_id = str(payload.get("request_id") or "")
        with self._lock:
            pending = self._pending.get(request_id)
            if pending is None or pending.done or pending.device_id != device.device_id:
                raise TalariaError("no such request for this device")
            if pending.claimed:
                raise TalariaError("request already claimed")
            pending.claimed = True
        device.last_seen = self.clock()
        return {"request_id": pending.request_id, "op": pending.op, "args": pending.args,
                "timeout": pending.timeout, "digest": pending.digest}

    def result(self, envelope: Any) -> dict:
        device, payload = self.open_envelope(envelope, "result")
        request_id = str(payload.get("request_id") or "")
        with self._lock:
            pending = self._pending.get(request_id)
            if (pending is None or pending.done or not pending.claimed
                    or pending.device_id != device.device_id):
                return {"accepted": False}
            if payload.get("digest") != pending.digest:
                raise EnvelopeError("result names a different request than the one claimed")
            pending.ok = payload.get("ok") is True
            pending.result = payload.get("result") if pending.ok else str(payload.get("error") or "failed")
            pending.done = True
            pending.event.set()
        return {"accepted": True}

    # -- the agent side ----------------------------------------------------------------------

    def resolve_device(self, name: Optional[str], session_ids: list[str]) -> Device:
        """The explicit device, else the device this conversation was last used from. Never guesses."""
        now = self.clock()
        if name:
            device = self.store.by_name(name) or self.close_match(name)
            if device is None:
                raise TalariaError(f"no device named {name!r}. {self.describe_devices(now)}")
            if not device.approved:
                raise TalariaError(f"{device.name} is waiting for approval. The user approves it by "
                                   f"typing /talaria approve {device.name} in a chat. Nothing ran.")
            return device
        best, best_at = None, 0.0
        for device in self.store.all():
            for sid in session_ids:
                at = device.sessions.get(sid, 0.0)
                if at > best_at and device.usable(now):
                    best, best_at = device, at
        if best is None:
            raise TalariaError("this conversation is not open on any device with Talaria, so there is "
                               "no default device. Pass `device`. " + self.describe_online(now))
        return best

    def close_match(self, name: str) -> Optional[Device]:
        """A misspelt name ("scopuri" for "scopuli"): the one approved device within two edits, if
        exactly one is. Short names and ties match nothing."""
        key = name.strip().lower()
        if len(key) < 4:
            return None
        close = [d for d in self.store.all() if d.approved and _edit_distance(key, d.name) <= 2]
        return close[0] if len(close) == 1 else None

    def describe_devices(self, now: Optional[float] = None) -> str:
        """Every approved device by its exact name, for an agent that got a name wrong."""
        now = self.clock() if now is None else now
        names = [d.name + ("" if d.online(now) else " (offline)") for d in self.store.all() if d.approved]
        return ("The user's devices are: " + ", ".join(names) + ". Use one of these names exactly."
                if names else "The user has no approved devices.")

    def describe_online(self, now: Optional[float] = None) -> str:
        now = self.clock() if now is None else now
        names = [d.name for d in self.store.all() if d.usable(now)]
        return "Online devices: " + (", ".join(names) if names else "none") + "."

    def cancel_device(self, device_id: str) -> None:
        """Fail every request waiting on a device, e.g. one just revoked."""
        with self._lock:
            for pending in self._pending.values():
                if pending.device_id == device_id and not pending.done:
                    pending.ok, pending.result, pending.done = False, "the device was revoked", True
                    pending.event.set()

    def describe_device(self, device: Device) -> str:
        """Where a device's paths live, so the model can retry with a path that fits it."""
        folders = ", ".join(device.roots) or "none set"
        return (f"{device.name} is a {device.platform or 'unknown'} device; its allowed folders are: "
                f"{folders}. Use absolute paths inside one of them.")

    def dispatch(self, device: Device, op: str, args: dict, timeout: float) -> Any:
        """Send one operation to a device and block for its signed result."""
        if op not in OPS:
            raise TalariaError(f"unknown operation {op!r}")
        if not device.approved:
            raise TalariaError(f"{device.name} is waiting for approval; nothing ran.")
        if not device.online(self.clock()):
            raise TalariaError(f"{device.name} is offline. {self.describe_online()}")
        ability = ABILITY_OPS.get(op)
        if ability and ability not in device.abilities:
            able = [d.name for d in self.store.all() if d.usable(self.clock()) and ability in d.abilities]
            raise TalariaError(
                f"{device.name} does not allow the {ability}. It needs the Talaria background helper "
                f"with the {ability} switched on in Talaria's settings there. Nothing ran. "
                + (f"Devices that allow it: {', '.join(able)}." if able else "No online device allows it."))
        request_id = secrets.token_hex(16)
        pending = Pending(request_id, device.device_id, op, args, timeout, self.clock(),
                          request_digest(request_id, op, args))
        with self._lock:
            self._pending[request_id] = pending
        try:
            self.notify("request", {"request_id": request_id, "device_id": device.device_id})
            deadline = time.monotonic() + CLAIM_TIMEOUT_S
            while not pending.claimed and not pending.done:
                if time.monotonic() >= deadline:
                    raise TalariaError(f"{device.name} did not pick up the request; the app may be "
                                       "closed or the Talaria plugin disabled there. Nothing ran.")
                pending.event.wait(0.1)
            if not pending.event.wait(timeout + RESULT_GRACE_S):
                self.notify("cancel", {"request_id": request_id, "device_id": device.device_id})
                raise TalariaError(f"{device.name} did not answer within {int(timeout)}s; it may still "
                                   "be running. Asked the device to stop it.")
            if not pending.ok:
                hint = "" if op in ABILITY_OPS else f" {self.describe_device(device)}"
                raise TalariaError(f"{device.name} refused or failed: {pending.result}.{hint}")
            return pending.result
        finally:
            with self._lock:
                pending.done = True
                self._pending.pop(request_id, None)


# --------------------------------------------------------------------------- one per process

_SHARED_KEY = "hermes_talaria_core"


def shared() -> "Talaria":
    """The process-wide instance, whichever of Hermes' two imports of this plugin asks first."""
    module = sys.modules.get(_SHARED_KEY)
    if module is None:
        spec = importlib.util.spec_from_file_location(_SHARED_KEY, Path(__file__))
        module = importlib.util.module_from_spec(spec)
        sys.modules[_SHARED_KEY] = module
        spec.loader.exec_module(module)
    with module._INSTANCE_LOCK:
        if module._INSTANCE is None:
            module._INSTANCE = module.Talaria(module.DeviceStore(module._store_path()),
                                              notify=module._broadcast)
        return module._INSTANCE


_INSTANCE: Optional[Talaria] = None
_INSTANCE_LOCK = threading.Lock()


def _store_path() -> Path:
    """One device list per backend, in the root Hermes home. Every agent (profile) the backend serves
    shares it, rather than whichever profile happened to load the plugin first."""
    try:
        from hermes_constants import get_default_hermes_root
        home = get_default_hermes_root()
    except ImportError:  # older Hermes
        from hermes_constants import get_hermes_home
        home = get_hermes_home()
    return Path(home) / "talaria" / "devices.json"


def _broadcast(event: str, payload: dict) -> None:
    from hermes_cli.plugin_events import broadcast_plugin_event
    broadcast_plugin_event("talaria", event, payload)
