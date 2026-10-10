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


_DEVICE = {"type": "string", "description": "Device name. Omit to use the device this conversation "
                                            "was last used from."}

TOOLS = {
    "talaria_list": ("list", "List a folder on a device. Paths are absolute paths on that device.",
                     {"path": {"type": "string"}, "device": _DEVICE}, ["path"]),
    "talaria_read": ("read", "Read a text file on a device (up to 512 KB).",
                     {"path": {"type": "string"}, "device": _DEVICE}, ["path"]),
    "talaria_write": ("write", "Write a text file on a device (up to 1,000,000 characters). The folder "
                               "must already exist. Overwrites an existing file.",
                      {"path": {"type": "string"}, "content": {"type": "string"}, "device": _DEVICE},
                      ["path", "content"]),
    "talaria_run": ("run", "Run one command in the device's own shell (see talaria_devices for which "
                           "shell; it may not be Bash) and return its output and exit code.",
                    {"command": {"type": "string"}, "cwd": {"type": "string",
                     "description": "Absolute folder on the device to run in."},
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
                "description": "List the user's devices with Talaria: online or not, their shell, the "
                               "folders each allows, and which is the default for this conversation.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False}},
    )
    ctx.register_command("talaria", handler=_slash,
                         description="List Talaria devices, or `forget <name>` to remove one.")
