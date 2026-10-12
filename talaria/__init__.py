"""Talaria: hands for Hermes on the device in front of you.

The agent half. Registers the ``talaria_*`` tools and the ``/talaria`` command. Each tool call goes
to one named device, by default the device this conversation was last used from, and fails rather
than running anywhere else.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_CORE = "hermes_talaria_core"


def _core():
    """core.py, loaded once per process under a fixed name shared with the dashboard routes."""
    module = sys.modules.get(_CORE)
    if module is None:
        spec = importlib.util.spec_from_file_location(_CORE, Path(__file__).with_name("core.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[_CORE] = module
        spec.loader.exec_module(module)
    return module


def _conversation_session_ids() -> list[str]:
    """Runtime session ids of the live chats carrying this agent's conversation."""
    from gateway.session_context import get_session_env
    key = get_session_env("HERMES_SESSION_KEY", "")
    server = sys.modules.get("tui_gateway.server")
    if not key or server is None:
        return []
    with server._sessions_lock:
        return [sid for sid, s in server._sessions.items() if s.get("session_key") == key]


def _in_isolated_turn() -> bool:
    import os
    return os.environ.get("HERMES_COMPUTE_HOST_CHILD") == "1"


_DEVICE = {"type": "string", "description": "Device name from talaria_devices, e.g. \"macbook\". "
                                            "Omit to use the device this conversation was last used "
                                            "from."}

# Shared lead for every device tool, so the model picks Talaria over its own server-side file and
# terminal tools whenever the user means their own computer.
_LEAD = ("Talaria: acts on the user's own computer (the device they chat from, or one they name), "
         "never on the server. Use this, not the server file or terminal tools, for anything on "
         "\"my Mac\", \"my laptop\", \"my desktop\" or a path the user gave from their device. "
         "Only folders the user allowed on that device work, and paths must be absolute in that "
         "device's own form (C:\\... on Windows, /Users/... on a Mac). Each device has its own "
         "folders; call talaria_devices to see which device is the default and its folders. ")

TOOLS = {
    "talaria_list": ("list", _LEAD + "Lists a folder: its entries, which may be none.",
                     {"path": {"type": "string", "description": "Absolute folder path on the device."},
                      "device": _DEVICE}, ["path"]),
    "talaria_read": ("read", _LEAD + "Reads a text file (up to 512 KB).",
                     {"path": {"type": "string", "description": "Absolute file path on the device."},
                      "device": _DEVICE}, ["path"]),
    "talaria_write": ("write", _LEAD + "Writes a text file (up to 1,000,000 characters). The folder "
                                       "must already exist. Overwrites an existing file.",
                      {"path": {"type": "string", "description": "Absolute file path on the device."},
                       "content": {"type": "string"}, "device": _DEVICE},
                      ["path", "content"]),
    "talaria_run": ("run", _LEAD + "Runs one command in the device's own shell and returns its output "
                                   "and exit code. The shell may be zsh or PowerShell, not Bash; "
                                   "talaria_devices says which.",
                    {"command": {"type": "string"}, "cwd": {"type": "string",
                     "description": "Absolute folder on the device to run in, inside an allowed folder."},
                     "timeout": {"type": "integer", "minimum": 1, "maximum": 120, "default": 30},
                     "device": _DEVICE}, ["command", "cwd"]),
}


def _error(message: str) -> str:
    return json.dumps({"error": message, "ran_on_server": False})


def _make_handler(op: str):
    def handler(args: dict, **kwargs) -> str:
        core = _core()
        if _in_isolated_turn():
            return _error("Talaria does not work with dashboard.turn_isolation yet; nothing ran.")
        args = dict(args or {})
        name = args.pop("device", None)
        try:
            talaria = core.shared()
            device = talaria.resolve_device(name, _conversation_session_ids())
            timeout = 30
            if op == "run":
                timeout = max(1, min(core.MAX_RUN_TIMEOUT_S, int(args.get("timeout") or 30)))
                args["timeout"] = timeout
            result = talaria.dispatch(device, op, args, timeout)
            return json.dumps({"device": device.name, "result": result})
        except core.TalariaError as exc:
            return _error(str(exc))
    return handler


def _devices(args: dict, **kwargs) -> str:
    core = _core()
    talaria = core.shared()
    now = talaria.clock()
    try:
        default = talaria.resolve_device(None, _conversation_session_ids()).name
    except core.TalariaError:
        default = None
    return json.dumps({"devices": [d.public(now) for d in talaria.store.all()],
                       "default_for_this_conversation": default})


def _slash(raw: str) -> str:
    talaria = _core().shared()
    parts = (raw or "").split()
    if parts[:1] == ["forget"] and len(parts) == 2:
        if talaria.store.forget(parts[1]):
            return f"Forgot {parts[1]}. It can enroll again by saying hello."
        return f"No device named {parts[1]}."
    lines = [f"{d.name}  {'online' if d.online(talaria.clock()) else 'offline'}  "
             f"key {d.device_id[:8]}  folders: {', '.join(d.roots) or 'none'}"
             for d in talaria.store.all()]
    return "\n".join(lines) or "No devices enrolled yet."


def register(ctx) -> None:
    for name, (op, description, properties, required) in TOOLS.items():
        ctx.register_tool(
            name=name, toolset="talaria", handler=_make_handler(op),
            schema={"name": name, "description": description,
                    "parameters": {"type": "object", "properties": properties, "required": required,
                                   "additionalProperties": False}},
        )
    ctx.register_tool(
        name="talaria_devices", toolset="talaria", handler=_devices,
        schema={"name": "talaria_devices",
                "description": "Talaria: lists the user's own computers the agent can act on (never the "
                               "server): online or not, their shell, the folders each allows, and "
                               "which is the default for this conversation. Call this first when "
                               "the user asks about files or commands on their device.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
    )
    ctx.register_command("talaria", handler=_slash,
                         description="List Talaria devices, or `forget <name>` to remove one.")
