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


def test_revoke_command_locks_a_device_out(hermes):
    client, _ = hermes
    from hermes_cli.plugins import get_plugin_command_handler
    command = get_plugin_command_handler("talaria")
    device = FakeDevice("itest-lost")
    _hello(client, device)
    assert command("revoke itest-lost").startswith("Revoked itest-lost")
    payload = {"name": "itest-lost", "platform": "linux", "shell": "bash", "roots": [], "sessions": []}
    r = client.post("/api/plugins/talaria/hello", json=device.envelope("hello", payload, with_key=True))
    assert r.status_code == 403


def test_system_prompt_points_the_agent_at_talaria(hermes):
    from hermes_cli.plugins import get_plugin_manager
    section = get_plugin_manager()._system_prompt_sections.get("talaria.devices")
    assert section is not None and "talaria_*" in section.content


# ---------------------------------------------------------------- the background helper, for real

HELPER = Path(__file__).resolve().parents[2] / "helper" / "talaria-helper.mjs"


def _free_port():
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def helper(hermes, tmp_path_factory):
    """The real helper process, talking HTTP to a real dashboard server on a free port."""
    import json
    import subprocess
    import urllib.request
    import uvicorn
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    from hermes_cli import web_server
    port, local_port = _free_port(), _free_port()
    server = uvicorn.Server(uvicorn.Config(web_server.app, host="127.0.0.1", port=port,
                                           lifespan="off", log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    home = tmp_path_factory.mktemp("helper_home")
    allowed = tmp_path_factory.mktemp("allowed")
    outside = tmp_path_factory.mktemp("outside")
    (outside / "secret.txt").write_text("not yours")
    (allowed / "escape.txt").symlink_to(outside / "secret.txt")
    (allowed / "escape-dir").symlink_to(outside)
    (home / "config.json").write_text(json.dumps({
        "server": f"http://127.0.0.1:{port}", "name": "itest-helper", "folders": [str(allowed)],
        "local_port": local_port}))
    (home / "secrets.json").write_text(json.dumps({"token": "test-token"}))
    env = dict(os.environ, TALARIA_HELPER_HOME=str(home), TALARIA_HELPER_SECRETS="file",
               SHELL="/bin/sh")
    proc = subprocess.Popen(["node", str(HELPER), "run"], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    yield {"allowed": allowed, "outside": outside, "local": f"http://127.0.0.1:{local_port}",
           "urlopen": urllib.request.urlopen, "Request": urllib.request.Request}
    proc.terminate()
    server.should_exit = True


def _wait_for(predicate, what):
    for _ in range(100):
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


def test_helper_enrolls_waits_for_approval_and_does_the_work(hermes, helper):
    import json
    from hermes_cli.plugins import get_plugin_command_handler
    _, registry = hermes
    talaria = __import__("sys").modules["hermes_talaria_core"].shared()
    device = _wait_for(lambda: talaria.store.by_name("itest-helper"), "the helper's hello")
    assert device.approved is False and device.shell == "sh"
    call = lambda tool, **args: json.loads(registry.get_entry(tool).handler(
        {**args, "device": "itest-helper"}))
    assert "waiting for approval" in call("talaria_list", path=str(helper["allowed"]))["error"]
    command = get_plugin_command_handler("talaria")
    assert command(f"approve itest-helper {device.device_id[:8]}").startswith("Approved")

    allowed = helper["allowed"]
    assert call("talaria_write", path=f"{allowed}/hi.txt", content="hello")["result"]["written"]
    assert call("talaria_read", path=f"{allowed}/hi.txt")["result"]["text"] == "hello"
    names = {e["name"] for e in call("talaria_list", path=str(allowed))["result"]["entries"]}
    assert {"hi.txt", "escape.txt"} <= names
    run = call("talaria_run", command="pwd; echo out; exit 3", cwd=str(allowed))["result"]
    assert run["exit_code"] == 3 and run["output"].endswith("out") and not run["timed_out"]

    # Symlinks that lead outside the allowed folder are refused, for every operation.
    for tool, args in (("talaria_read", {"path": f"{allowed}/escape.txt"}),
                       ("talaria_write", {"path": f"{allowed}/escape.txt", "content": "x"}),
                       ("talaria_write", {"path": f"{allowed}/escape-dir/new.txt", "content": "x"}),
                       ("talaria_list", {"path": f"{allowed}/escape-dir"}),
                       ("talaria_run", {"command": "true", "cwd": f"{allowed}/escape-dir"})):
        assert "resolves outside" in call(tool, **args)["error"], (tool, args)
    assert (helper["outside"] / "secret.txt").read_text() == "not yours"
    assert not (helper["outside"] / "new.txt").exists()


def test_desktop_hands_the_helper_its_chats_and_web_pages_are_refused(hermes, helper):
    import json
    import urllib.error
    talaria = __import__("sys").modules["hermes_talaria_core"].shared()
    _wait_for(lambda: talaria.store.by_name("itest-helper"), "the helper's hello")
    body = json.dumps({"sessions": [{"session_id": "chat-1", "at": int(time.time() * 1000)}]}).encode()
    req = helper["Request"](f"{helper['local']}/sessions", data=body, method="POST",
                            headers={"content-type": "application/json", "origin": "file://"})
    assert json.loads(helper["urlopen"](req).read()) == {"ok": True}
    _wait_for(lambda: "chat-1" in talaria.store.by_name("itest-helper").sessions, "the chat claim")
    status = json.loads(helper["urlopen"](f"{helper['local']}/status").read())
    assert status["name"] == "itest-helper"
    evil = helper["Request"](f"{helper['local']}/status", headers={"origin": "https://example.com"})
    with pytest.raises(urllib.error.HTTPError) as caught:
        helper["urlopen"](evil)
    assert caught.value.code == 403
