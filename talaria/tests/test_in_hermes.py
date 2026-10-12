"""End to end inside a real Hermes: the dashboard app, the plugin loader, the tool registry, and a
simulated device talking to the plugin's routes. Skipped when Hermes is not installed."""
import os
import shutil
import threading
import time
from pathlib import Path

import pytest

pytest.importorskip("hermes_cli")

from test_core import FakeDevice  # noqa: E402  (signs the way plugin.js does; see the interop test)


@pytest.fixture(scope="module")
def hermes(tmp_path_factory):
    home = tmp_path_factory.mktemp("hermes_home")
    (home / "plugins").mkdir()
    os.symlink(Path(__file__).resolve().parent.parent, home / "plugins" / "talaria")
    (home / "config.yaml").write_text("plugins:\n  enabled:\n    - talaria\n")
    old = os.environ.get("HERMES_HOME")
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = "test-token"
    from fastapi.testclient import TestClient
    from hermes_cli import web_server
    import model_tools  # noqa: F401  (plugin discovery)
    from tools.registry import registry
    with TestClient(web_server.app) as client:
        client.headers["Authorization"] = "Bearer test-token"
        yield client, registry
    if old is None:
        os.environ.pop("HERMES_HOME", None)
    else:
        os.environ["HERMES_HOME"] = old


def _hello(client, device):
    payload = {"name": device.name, "platform": "linux", "shell": "bash", "roots": ["/tmp"], "sessions": []}
    r = client.post("/api/plugins/talaria/hello", json=device.envelope("hello", payload, with_key=True))
    assert r.status_code == 200, r.text
    return r.json()


def test_routes_need_the_dashboard_login(hermes):
    client, _ = hermes
    assert client.get("/api/plugins/talaria/devices", headers={"Authorization": ""}).status_code == 401


def test_tool_call_reaches_the_device_and_back(hermes):
    client, registry = hermes
    device = FakeDevice("itest-box")
    assert _hello(client, device)["approved"] is False
    # A new device is sent nothing until the user approves it with the slash command.
    waiting = registry.get_entry("talaria_read").handler({"path": "/tmp/x.txt", "device": "itest-box"})
    assert "waiting for approval" in waiting
    from hermes_cli.plugins import get_plugin_command_handler
    approve = get_plugin_command_handler("talaria")
    assert "WAITING FOR APPROVAL" in approve("")
    assert approve(f"approve itest-box {device.device_id[:8]}").startswith("Approved itest-box")
    out = {}
    worker = threading.Thread(target=lambda: out.setdefault(
        "r", registry.get_entry("talaria_read").handler({"path": "/tmp/x.txt", "device": "itest-box"})))
    worker.start()
    for _ in range(50):
        pending = _hello(client, device)["pending"]
        if pending:
            break
        time.sleep(0.1)
    req = client.post("/api/plugins/talaria/claim",
                      json=device.envelope("claim", {"request_id": pending[0]})).json()
    assert (req["op"], req["args"]) == ("read", {"path": "/tmp/x.txt"})
    r = client.post("/api/plugins/talaria/result", json=device.envelope(
        "result", {"request_id": pending[0], "ok": True, "digest": req["digest"], "result": {"text": "hi"}}))
    assert r.json() == {"accepted": True}
    worker.join()
    assert '"result": {"text": "hi"}' in out["r"]


def test_no_default_device_means_refusal_not_the_server(hermes):
    _, registry = hermes
    out = registry.get_entry("talaria_list").handler({"path": "/tmp"})
    assert "no default device" in out and '"ran_on_server": false' in out


def test_unenrolled_key_is_forbidden(hermes):
    client, _ = hermes
    r = client.post("/api/plugins/talaria/claim", json=FakeDevice("x").envelope("claim", {"request_id": "r"}))
    assert r.status_code == 403
