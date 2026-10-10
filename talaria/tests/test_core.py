import base64
import json
import secrets
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import importlib.util

_spec = importlib.util.spec_from_file_location("talaria_core_under_test",
                                               Path(__file__).parent.parent / "core.py")
core = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = core
_spec.loader.exec_module(core)


class FakeDevice:
    """Signs envelopes the way desktop/plugin.js does."""

    def __init__(self, name="desk"):
        self.key = Ed25519PrivateKey.generate()
        raw = self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.public_key = base64.b64encode(raw).decode()
        self.device_id = core.device_id_for(raw)
        self.name = name

    def envelope(self, kind, payload, *, ts=None, nonce=None, with_key=False):
        text = json.dumps(payload)
        ts = int(time.time() * 1000) if ts is None else ts
        nonce = nonce or secrets.token_hex(12)
        sig = self.key.sign(core.signing_message(kind, self.device_id, ts, nonce, text))
        env = {"v": 1, "kind": kind, "device_id": self.device_id, "ts": ts, "nonce": nonce,
               "payload": text, "sig": base64.b64encode(sig).decode()}
        if with_key:
            env["public_key"] = self.public_key
        return env

    def hello(self, t, sessions=(), **extra):
        payload = {"name": self.name, "platform": "linux", "shell": "bash", "roots": ["/home/k"],
                   "sessions": [{"session_id": s, "at": int(time.time() * 1000)} for s in sessions]}
        payload.update(extra)
        return t.hello(self.envelope("hello", payload, with_key=True))


@pytest.fixture
def t(tmp_path):
    events = []
    talaria = core.Talaria(core.DeviceStore(tmp_path / "devices.json"),
                           notify=lambda e, p: events.append((e, p)))
    talaria.events = events
    return talaria


def test_hello_enrolls_and_persists(t, tmp_path):
    d = FakeDevice()
    assert d.hello(t)["name"] == "desk"
    again = core.DeviceStore(tmp_path / "devices.json")
    assert again.by_name("desk").device_id == d.device_id


def test_name_is_bound_to_first_key(t):
    FakeDevice("desk").hello(t)
    with pytest.raises(core.EnvelopeError, match="belongs to another device"):
        FakeDevice("desk").hello(t)


def test_forget_frees_the_name(t):
    FakeDevice("desk").hello(t)
    assert t.store.forget("desk")
    FakeDevice("desk").hello(t)


def test_bad_signature_replay_and_stale_are_refused(t):
    d = FakeDevice()
    d.hello(t)
    env = d.envelope("hello", {"name": "desk"})
    env["payload"] = json.dumps({"name": "evil"})
    with pytest.raises(core.EnvelopeError, match="bad signature"):
        t.hello(env)
    env = d.envelope("hello", {"name": "desk"}, nonce="n" * 16)
    t.hello(env)
    with pytest.raises(core.EnvelopeError, match="replayed"):
        t.hello(env)
    with pytest.raises(core.EnvelopeError, match="stale"):
        t.hello(d.envelope("hello", {"name": "desk"}, ts=int(time.time() * 1000) - 600_000))


def test_unknown_device_cannot_claim(t):
    with pytest.raises(core.EnvelopeError, match="unknown device"):
        t.claim(FakeDevice().envelope("claim", {"request_id": "x"}))


def test_default_device_is_the_one_the_conversation_was_last_used_from(t):
    a, b = FakeDevice("desk"), FakeDevice("laptop")
    a.hello(t, sessions=["s1"])
    time.sleep(0.01)
    b.hello(t, sessions=["s1"])
    assert t.resolve_device(None, ["s1"]).name == "laptop"
    with pytest.raises(core.TalariaError, match="no default device"):
        t.resolve_device(None, ["other"])
    assert t.resolve_device("desk", []).name == "desk"


def _serve(t, device, ok=True, result=None, digest=None):
    """Play the device: wait for the nudge, claim, answer."""
    def run():
        while not t.events:
            time.sleep(0.01)
        _, nudge = t.events[-1]
        assert set(nudge) == {"request_id", "device_id"}  # the broadcast carries no contents
        req = t.claim(device.envelope("claim", {"request_id": nudge["request_id"]}))
        t.result(device.envelope("result", {"request_id": req["request_id"], "ok": ok,
                                            "digest": digest or req["digest"],
                                            "result": result if ok else None,
                                            "error": None if ok else "outside allowed folders"}))
    thread = threading.Thread(target=run)
    thread.start()
    return thread


def test_dispatch_round_trip(t):
    d = FakeDevice()
    d.hello(t)
    thread = _serve(t, d, result={"text": "hi"})
    device = t.store.by_name("desk")
    assert t.dispatch(device, "read", {"path": "/home/k/a.txt"}, 5) == {"text": "hi"}
    thread.join()


def test_device_refusal_is_reported(t):
    d = FakeDevice()
    d.hello(t)
    thread = _serve(t, d, ok=False)
    with pytest.raises(core.TalariaError, match="outside allowed folders"):
        t.dispatch(t.store.by_name("desk"), "read", {"path": "/etc/passwd"}, 5)
    thread.join()


def test_result_must_name_the_claimed_request(t):
    d = FakeDevice()
    d.hello(t)
    errors = []

    def run():
        while not t.events:
            time.sleep(0.01)
        req = t.claim(d.envelope("claim", {"request_id": t.events[-1][1]["request_id"]}))
        try:
            t.result(d.envelope("result", {"request_id": req["request_id"], "ok": True,
                                           "digest": "0" * 64, "result": {}}))
        except core.EnvelopeError as exc:
            errors.append(exc)
    thread = threading.Thread(target=run)
    thread.start()
    with pytest.raises(core.TalariaError):
        t.dispatch(t.store.by_name("desk"), "run", {"command": "ls"}, 0.2)
    thread.join()
    assert errors and "different request" in str(errors[0])


def test_other_device_cannot_claim_or_answer(t):
    a, b = FakeDevice("desk"), FakeDevice("laptop")
    a.hello(t)
    b.hello(t)
    seen = []

    def run():
        while not t.events:
            time.sleep(0.01)
        rid = t.events[-1][1]["request_id"]
        with pytest.raises(core.TalariaError, match="no such request"):
            t.claim(b.envelope("claim", {"request_id": rid}))
        seen.append(True)
    thread = threading.Thread(target=run)
    thread.start()
    old = core.CLAIM_TIMEOUT_S
    core.CLAIM_TIMEOUT_S = 0.5
    try:
        with pytest.raises(core.TalariaError, match="did not pick up"):
            t.dispatch(t.store.by_name("desk"), "list", {"path": "/"}, 1)
    finally:
        core.CLAIM_TIMEOUT_S = old
    thread.join()
    assert seen


def test_offline_device_is_refused_without_dispatch(t):
    d = FakeDevice()
    d.hello(t)
    device = t.store.by_name("desk")
    device.last_seen -= core.ONLINE_WINDOW_S + 1
    with pytest.raises(core.TalariaError, match="offline"):
        t.dispatch(device, "list", {"path": "/"}, 1)
    assert t.events == []


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node for the Desktop half")
def test_envelopes_signed_by_the_desktop_half_verify(t):
    here = Path(__file__).parent / "js"
    out = subprocess.run(["node", "--import", str(here / "register.mjs"), str(here / "envelope.mjs")],
                         capture_output=True, text=True, check=True).stdout
    envelopes = json.loads(out)
    assert t.hello(envelopes["hello"])["name"] == "node-device"
    with pytest.raises(core.TalariaError, match="no such request"):
        t.claim(envelopes["claim"])  # signature accepted; the request simply does not exist
