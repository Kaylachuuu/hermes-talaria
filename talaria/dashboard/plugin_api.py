"""Talaria device routes, mounted at /api/plugins/talaria/.

Every route but ``/devices`` takes a signed envelope from a device (see ``core.py``). The
dashboard's own login decides who may reach these routes at all; the device signature decides
which device is speaking.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()
_CORE = "hermes_talaria_core"


def _core():
    module = sys.modules.get(_CORE)
    if module is None:
        spec = importlib.util.spec_from_file_location(_CORE, Path(__file__).parent.parent / "core.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[_CORE] = module
        spec.loader.exec_module(module)
    return module


def _call(method: str, body: dict) -> dict:
    core = _core()
    try:
        return getattr(core.shared(), method)(body)
    except core.EnvelopeError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from None
    except core.TalariaError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.post("/hello")
def hello(body: dict) -> dict:
    return _call("hello", body)


@router.post("/claim")
def claim(body: dict) -> dict:
    return _call("claim", body)


@router.post("/result")
def result(body: dict) -> dict:
    return _call("result", body)


@router.get("/devices")
def devices() -> dict:
    talaria = _core().shared()
    now = talaria.clock()
    return {"devices": [d.public(now) for d in talaria.store.all()]}


@router.get("/helper")
def helper() -> dict:
    """The background helper's source, for Hermes Desktop's Install button."""
    path = Path(__file__).resolve().parents[2] / "helper" / "talaria-helper.mjs"
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"no helper at {path}; is the plugin a checkout of hermes-talaria?")
    source = path.read_text(encoding="utf-8")
    version = next((line.split("'")[1] for line in source.splitlines()
                    if line.startswith("export const VERSION")), "")
    return {"source": source, "version": version}
