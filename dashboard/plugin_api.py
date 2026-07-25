"""Hermes dashboard routes for the T3 Code companion service."""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

from integrations.hermes_plugin.config import load_config
from integrations.hermes_plugin import service

router = APIRouter()
_ACTION_LOCK = threading.Lock()


async def _acquire_action_lock() -> None:
    while not _ACTION_LOCK.acquire(blocking=False):
        await asyncio.sleep(0.05)


def _public_url(request: Request) -> str:
    config = load_config(plugin_root=PLUGIN_ROOT)
    if config.public_url:
        return config.public_url.rstrip("/")
    hostname = request.url.hostname or "127.0.0.1"
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    # T3 serves plain HTTP itself. HTTPS deployments should set
    # T3CODE_HERMES_PUBLIC_URL to the operator's TLS-terminating proxy URL.
    return f"http://{hostname}:{config.port}"


def _response(request: Request) -> dict[str, object]:
    config = load_config(plugin_root=PLUGIN_ROOT)
    current = service.status(config).to_dict()
    current["url"] = _public_url(request)
    current["plugin_root"] = str(config.plugin_root)
    current["watch_interval_seconds"] = config.watch_interval_seconds
    current["watch_misses"] = config.watch_misses
    return current


@router.get("/status")
async def get_status(request: Request) -> dict[str, object]:
    try:
        return await asyncio.to_thread(_response, request)
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


async def _run_action(action: str, request: Request) -> dict[str, object]:
    config = load_config(plugin_root=PLUGIN_ROOT)
    handler = {
        "install": service.install,
        "update": service.update,
        "uninstall": service.uninstall,
    }[action]
    try:
        await _acquire_action_lock()
        try:
            result = await asyncio.to_thread(handler, config)
            result["status"] = _response(request)
            return result
        finally:
            _ACTION_LOCK.release()
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@router.post("/install")
async def install(request: Request) -> dict[str, object]:
    return await _run_action("install", request)


@router.post("/update")
async def update(request: Request) -> dict[str, object]:
    return await _run_action("update", request)


@router.post("/uninstall")
async def uninstall(request: Request) -> dict[str, object]:
    return await _run_action("uninstall", request)
