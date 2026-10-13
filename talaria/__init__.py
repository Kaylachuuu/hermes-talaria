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

_BROWSER = ("Talaria: drives a web browser on the user's own computer (a Chrome or Edge window they "
            "can watch, with its own Talaria profile), never on the server. Only devices whose "
            "talaria_devices entry lists \"browser\" under `can` allow it. Every action returns the "
            "page as text: links, buttons and fields are numbered like [3]; pass that number as `ref`. "
            "Numbers change after each action, so use the ones from the latest result. Actions: "
            "open (url), snapshot, click (ref), type (ref, text, submit), select (ref, text: the "
            "option), press (key, e.g. Enter, Tab, Escape, ctrl+a), scroll (direction up/down), back, "
            "screenshot (an image of the page), close.")
_BROWSER_PARAMS = {
    "action": {"type": "string", "enum": ["open", "snapshot", "click", "type", "select", "press",
                                          "scroll", "back", "screenshot", "close"]},
    "url": {"type": "string", "description": "open: the address."},
    "ref": {"type": "integer", "description": "click/type/select: the element's number from the "
                                              "latest page text."},
    "text": {"type": "string", "description": "type: the text; select: the option to pick."},
    "submit": {"type": "boolean", "description": "type: press Enter afterwards."},
    "key": {"type": "string", "description": "press: the key or combination."},
    "direction": {"type": "string", "enum": ["up", "down"]},
    "browser": {"type": "string", "enum": ["chrome", "edge", "brave", "firefox", "safari"],
                "description": "Only if the user asks for a particular browser; otherwise the "
                               "device's chosen one."},
    "device": _DEVICE,
}

_SCREEN = ("Talaria: sees and controls the screen of the user's own computer (mouse and keyboard), "
           "never the server. Only devices whose talaria_devices entry lists \"screen\" under `can` "
           "allow it. Every action returns a fresh screenshot. Coordinates are [x, y] pixels in the "
           "latest screenshot (its `size` says how big it is), so take a screenshot first. Actions: "
           "screenshot, click (coordinate), double_click (coordinate), right_click (coordinate), "
           "scroll (coordinate, direction up/down, amount), type (text), key (keys, e.g. enter, "
           "ctrl+c, cmd+space, alt+tab), wait (seconds). For web pages prefer talaria_browser, which "
           "reads pages as text.")
_SCREEN_PARAMS = {
    "action": {"type": "string", "enum": ["screenshot", "click", "double_click", "right_click", "scroll",
                                          "type", "key", "wait"]},
    "coordinate": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2,
                   "description": "[x, y] in the latest screenshot."},
    "text": {"type": "string", "description": "type: the text to type."},
    "keys": {"type": "string", "description": "key: a key or combination joined with +."},
    "direction": {"type": "string", "enum": ["up", "down"]},
    "amount": {"type": "integer", "minimum": 1, "maximum": 20, "description": "scroll: wheel ticks."},
    "seconds": {"type": "number", "minimum": 0, "maximum": 10},
    "device": _DEVICE,
}


def _image_result(device: str, result: dict):
    """A result carrying a screenshot, in the shape Hermes hands to vision models (and summarises
    as text for the rest)."""
    image = result.pop("image", None)
    text = json.dumps({"device": device, "result": result})
    if not isinstance(image, dict) or not image.get("data"):
        return text
    url = f"data:{image.get('media_type') or 'image/png'};base64,{image['data']}"
    return {"_multimodal": True, "text_summary": text,
            "content": [{"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": url}}]}


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
            elif op in ("browser", "screen"):
                timeout = 60
            result = talaria.dispatch(device, op, args, timeout)
            if isinstance(result, dict) and "image" in result:
                return _image_result(device.name, result)
            reply = {"device": device.name, "result": result}
            if name and name.strip().lower() != device.name:
                reply["note"] = f"There is no device named {name!r}; this ran on {device.name}."
            return json.dumps(reply)
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
    core = _core()
    talaria = core.shared()
    parts = (raw or "").split()
    if parts[:1] == ["forget"] and len(parts) == 2:
        if talaria.store.forget(parts[1]):
            return f"Forgot {parts[1]}. It can enroll again by saying hello, and will need approval."
        return f"No device named {parts[1]}."
    if parts[:1] == ["revoke"] and len(parts) == 2:
        try:
            devices = talaria.store.revoke(parts[1], talaria.clock())
        except core.TalariaError as exc:
            return str(exc)
        for device in devices:
            talaria.cancel_device(device.device_id)
        keys = ", ".join(d.device_id[:8] for d in devices)
        return (f"Revoked {devices[0].name} (key {keys}). It is refused from now on and "
                "its name is free. If the device is lost, also change the dashboard password: "
                "it is saved on that device too.")
    if parts[:1] == ["approve"] and len(parts) in (2, 3):
        try:
            device, replaced = talaria.store.approve(parts[1], parts[2] if len(parts) == 3 else "")
        except core.TalariaError as exc:
            return str(exc)
        if replaced is not None and replaced.device_id != device.device_id:
            return (f"Approved {device.name} (key {device.device_id[:8]}). It shares the name with key "
                    f"{replaced.device_id[:8]}, usually the Desktop app and its background helper; "
                    f"whichever is online does the work. If {replaced.device_id[:8]} is a device you no "
                    f"longer have, /talaria revoke {device.name} and approve the one you keep.")
        return f"Approved {device.name} (key {device.device_id[:8]})."
    now = talaria.clock()
    lines = [f"{d.name}  {'online' if d.online(now) else 'offline'}"
             f"{'' if d.approved else '  WAITING FOR APPROVAL'}  key {d.device_id[:8]}  "
             f"folders: {', '.join(d.roots) or 'none'}"
             for d in talaria.store.all()]
    waiting = [d for d in talaria.store.all() if not d.approved]
    if waiting:
        lines.append(f"Check the key shown on the device, then: "
                     f"/talaria approve {waiting[0].name} {waiting[0].device_id[:8]}")
    return "\n".join(lines) or "No devices enrolled yet."


# Added to every new session's system prompt. On the machine that hosts Hermes the built-in file and
# terminal tools reach the same disk as Talaria and look right, so the tool descriptions alone do not
# settle which to use.
_PROMPT = ("Talaria: the user's own computers (their laptop, desktop, Mac and so on) are reached only "
           "through the talaria_* tools. The built-in terminal and file tools act on the machine Hermes "
           "runs on, which is not the user's device even when it looks like it. For files, folders or "
           "commands on the user's device, use talaria_*; call talaria_devices to see the devices, "
           "their folders and which one is the default. The tool names are spelled talaria_ "
           "(t-a-l-a-r-i-a).")


def _prompt(_session=None) -> str:
    """The steering line, plus the user's devices as they stand when the session starts."""
    try:
        talaria = _core().shared()
        lines = []
        for d in talaria.store.all():
            if d.approved:
                folders = "; ".join(d.roots[:4]) or "none set"
                extra = [a for a in d.abilities if a != "files"]
                lines.append(f"- {d.name} ({d.platform or 'unknown'}): allowed folders {folders}"
                             + (f"; also allows: {', '.join(extra)}" if extra else ""))
    except Exception:
        lines = []
    if not lines:
        return _PROMPT
    return (_PROMPT + " The user's devices when this conversation started (names are exact; "
            "talaria_devices says which are online now):\n" + "\n".join(lines))[:1800]


def register(ctx) -> None:
    # Older Hermes builds lack prompt sections; the tool descriptions still steer there.
    if hasattr(ctx, "register_system_prompt_section"):
        ctx.register_system_prompt_section("talaria.devices", _prompt)
    for name, (op, description, properties, required) in TOOLS.items():
        ctx.register_tool(
            name=name, toolset="talaria", handler=_make_handler(op),
            schema={"name": name, "description": description,
                    "parameters": {"type": "object", "properties": properties, "required": required,
                                   "additionalProperties": False}},
        )
    ctx.register_tool(
        name="talaria_browser", toolset="talaria", handler=_make_handler("browser"),
        schema={"name": "talaria_browser", "description": _BROWSER,
                "parameters": {"type": "object", "properties": _BROWSER_PARAMS, "required": ["action"],
                               "additionalProperties": False}},
    )
    ctx.register_tool(
        name="talaria_screen", toolset="talaria", handler=_make_handler("screen"),
        schema={"name": "talaria_screen", "description": _SCREEN,
                "parameters": {"type": "object", "properties": _SCREEN_PARAMS, "required": ["action"],
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
                         description="List Talaria devices; `approve <name> [key]` to let a new one work, "
                                     "`revoke <name>` to lock out a lost one, `forget <name>` to "
                                     "remove one that may enroll again.")
