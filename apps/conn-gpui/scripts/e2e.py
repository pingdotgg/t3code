#!/usr/bin/env python3
"""End-to-end UI flow test suite for a live `Conn GPUI.app` window.

Drives real GPUI mouse clicks, right-clicks, hover paths, keystrokes, text input,
file attachment uploads, and CEF DOM actions over the `--features automation`
loopback socket (`CONN_GPUI_AUTOMATION`), asserting against the live AccessKit
tree, clipboard, app state dump, and crash/stderr logs.

Usage:
  CARGO_FLAGS="--features cef" ./scripts/run-app.sh --applications
  python3 scripts/e2e.py
"""
from __future__ import annotations

import base64
import json
import os
import socket
import sys
import tempfile
import time
from pathlib import Path

DEV_DIR = Path(os.environ.get("CONN_GPUI_DEV", "/tmp/conn-gpui-dev"))
PORT_FILE = Path(os.environ.get("CONN_GPUI_AUTOMATION", str(DEV_DIR / "automation-port")))
APP_LOG = Path(os.environ.get("CONN_GPUI_APP_LOG", str(DEV_DIR / "app.log")))
ALLOW_NO_VAULT = os.environ.get("CONN_E2E_ALLOW_NO_VAULT", "0") == "1"

# Minimal valid 1×1 transparent PNG for attachment upload verification.
TINY_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


class AutomationClient:
    def __init__(self, port: int) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=20.0)
        self.reader = self.sock.makefile("r", encoding="utf-8")

    def call(self, payload: dict) -> object:
        self.sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        line = self.reader.readline()
        if not line:
            raise RuntimeError(f"automation socket closed on {payload}")
        reply = json.loads(line)
        if "error" in reply:
            raise AssertionError(f"automation error for {payload}: {reply['error']}")
        return reply["result"]

    def close(self) -> None:
        self.reader.close()
        self.sock.close()


def assert_eq(actual: object, expected: object, msg: str) -> None:
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


def reset_ui(client: AutomationClient) -> None:
    """Close any open modal/popover and give the main shell active GPUI focus."""
    for _ in range(4):
        state = client.call({"cmd": "dump"})
        if not state.get("settings") and not state.get("palette"):
            break
        client.call({"cmd": "press", "key": "escape"})
        time.sleep(0.1)
    client.call({"cmd": "press", "key": "escape"})
    client.call({"cmd": "wait", "axId": "rail.all-projects", "timeoutMs": 3000})
    client.call({"cmd": "click", "axId": "rail.all-projects"})


def flow_command_palette_theme_switch(client: AutomationClient) -> None:
    initial = client.call({"cmd": "dump"})
    original_theme = initial["theme"]
    target_theme = "dark-ocean" if original_theme != "dark-ocean" else "t3-code-light"
    target_query = "Dark Ocean" if target_theme == "dark-ocean" else "T3 Code Light"

    client.call({"cmd": "press", "key": "cmd-k"})
    client.call({"cmd": "wait", "axId": "palette.modal", "timeoutMs": 3000})
    client.call({"cmd": "type", "text": target_query})
    client.call({"cmd": "press", "key": "enter"})
    client.call({"cmd": "wait", "absentAxId": "palette.modal", "timeoutMs": 3000})

    after = client.call({"cmd": "dump"})
    assert_eq(after["theme"], target_theme, "Cmd+K theme switch via real typing + Enter")

    client.call({"cmd": "press", "key": "cmd-k"})
    client.call({"cmd": "wait", "axId": "palette.modal", "timeoutMs": 3000})
    client.call({"cmd": "press", "key": "escape"})
    client.call({"cmd": "wait", "absentAxId": "palette.modal", "timeoutMs": 3000})

    client.call({"cmd": "theme", "id": original_theme})


def flow_thread_context_menu_copy_submenu(client: AutomationClient) -> None:
    state = client.call({"cmd": "dump"})
    threads = state.get("threads") or []
    if not threads:
        print("  [skip] thread context menu flow (no threads in shell)")
        return
    target_id = state.get("selectedThreadId") or threads[0]["id"]
    row_ax_id = f"sidebar.thread.{target_id}"
    client.call({"cmd": "wait", "axId": row_ax_id, "timeoutMs": 3000})

    # Right-click the thread card, hover Copy, move to Path, confirm submenu stays open, click Path.
    client.call({"cmd": "click", "axId": row_ax_id, "button": "right"})
    client.call({"cmd": "wait", "axId": "thread-menu.copy", "timeoutMs": 3000})
    client.call({"cmd": "hover", "axId": "thread-menu.copy"})
    client.call({"cmd": "wait", "axId": "thread-menu.copy.path", "timeoutMs": 3000})
    client.call({"cmd": "hover", "axId": "thread-menu.copy.path"})
    time.sleep(0.2)
    still_open = client.call({"cmd": "query", "axId": "thread-menu.copy.path"})
    if not still_open["matches"]:
        raise AssertionError("Copy submenu closed when hovering Path")
    client.call({"cmd": "click", "axId": "thread-menu.copy.path"})
    client.call({"cmd": "wait", "absentAxId": "thread-menu", "timeoutMs": 3000})

    copied = client.call({"cmd": "clipboard-read"})
    if not copied.get("text"):
        raise AssertionError(f"Copy -> Path did not populate clipboard: {copied!r}")


def flow_header_thread_details_popover(client: AutomationClient) -> None:
    client.call({"cmd": "wait", "axId": "header.thread-details", "timeoutMs": 3000})
    client.call({"cmd": "click", "axId": "header.thread-details"})
    client.call({"cmd": "wait", "axId": "header.details-card", "timeoutMs": 3000})
    client.call({"cmd": "press", "key": "escape"})
    client.call({"cmd": "wait", "absentAxId": "header.details-card", "timeoutMs": 3000})


def flow_composer_controls_and_image_attach(client: AutomationClient) -> None:
    # Open and dismiss the docked Model + Effort picker.
    client.call({"cmd": "wait", "axId": "composer.model-picker", "timeoutMs": 3000})
    client.call({"cmd": "click", "axId": "composer.model-picker"})
    time.sleep(0.15)
    client.call({"cmd": "press", "key": "escape"})

    # Toggle Plan/Build mode and toggle back.
    plan = client.call({"cmd": "query", "axId": "composer.plan-mode"})
    if plan["matches"]:
        client.call({"cmd": "click", "axId": "composer.plan-mode"})
        time.sleep(0.1)
        client.call({"cmd": "click", "axId": "composer.plan-mode"})

    # Attach a real PNG file through the composer upload pipeline (verifies Tokio runtime bridge).
    with tempfile.NamedTemporaryFile(prefix="conn-e2e-", suffix=".png", delete=False) as tmp:
        tmp.write(TINY_PNG_BYTES)
        tmp_path = Path(tmp.name)
    try:
        client.call({"cmd": "attach-file", "path": str(tmp_path)})
        time.sleep(0.5)
        # Ensure app stayed healthy and no upload error chip appeared.
        err = client.call({"cmd": "query", "label": "there is no reactor running"})
        assert_eq(err["matches"], [], "composer attachment upload hit Tokio runtime panic")
    finally:
        tmp_path.unlink(missing_ok=True)


def flow_settings_scheduled_tasks(client: AutomationClient) -> None:
    client.call({"cmd": "press", "key": "cmd-,"})
    client.call({"cmd": "wait", "axId": "settings.modal", "timeoutMs": 3000})

    client.call({"cmd": "click", "axId": "settings.nav.scheduled tasks"})
    client.call({"cmd": "wait", "axId": "settings.scheduled.new", "timeoutMs": 3000})

    client.call({"cmd": "click", "axId": "settings.scheduled.new"})
    client.call({"cmd": "wait", "axId": "settings.scheduled.save", "timeoutMs": 3000})

    client.call({"cmd": "click", "axId": "settings.scheduled.cancel"})
    client.call({"cmd": "wait", "axId": "settings.scheduled.new", "timeoutMs": 3000})
    client.call({"cmd": "press", "key": "escape"})
    client.call({"cmd": "wait", "absentAxId": "settings.modal", "timeoutMs": 3000})


def flow_database_panel_click_and_vault(client: AutomationClient) -> None:
    client.call({"cmd": "panel", "tab": "Database"})
    client.call({"cmd": "wait", "axId": "database.connection.trigger", "timeoutMs": 3000})
    client.call({"cmd": "click", "axId": "database.connection.trigger"})
    time.sleep(0.5)
    if not ALLOW_NO_VAULT:
        refused = client.call({"cmd": "query", "label": "Vault refused"})
        assert_eq(refused["matches"], [], "signed Conn GPUI.app should not be refused by Vault")
    client.call({"cmd": "press", "key": "escape"})


def flow_browser_cef_snapshot_and_act(client: AutomationClient) -> None:
    state = client.call({"cmd": "browser-state"})
    if state.get("cef") is False:
        print("  [skip] browser CEF flow (built without --features cef)")
        return
    html = (
        "data:text/html,"
        "<html><head><title>Conn E2E</title></head><body>"
        "<button id='inc' onclick=\"document.getElementById('out').textContent='clicked'\">Click me</button>"
        "<div id='out'>idle</div>"
        "</body></html>"
    )
    client.call({"cmd": "browse", "url": html})
    deadline = time.time() + 12.0
    while time.time() < deadline:
        title = client.call({"cmd": "browser-title"})
        if title == "Conn E2E":
            break
        time.sleep(0.25)
    assert_eq(client.call({"cmd": "browser-title"}), "Conn E2E", "CEF loaded E2E data page")

    snap = client.call({"cmd": "browser-snapshot"})
    assert snap["title"] == "Conn E2E", f"unexpected snapshot: {snap}"
    assert any(el["label"] == "Click me" for el in snap["elements"]), f"button missing in {snap['elements']}"

    btn_ref = next(el["ref"] for el in snap["elements"] if el["label"] == "Click me")
    client.call({"cmd": "browser-act", "action": "click", "locator": f"aria-ref={btn_ref}"})
    out = client.call(
        {"cmd": "browser-eval", "expression": "document.getElementById('out').textContent"}
    )
    assert_eq(out, "clicked", "browser-act click updated CEF DOM")


def snapshot_crash_reports() -> set[str]:
    crash_dir = Path.home() / "Library" / "Logs" / "DiagnosticReports"
    if not crash_dir.is_dir():
        return set()
    return {p.name for p in crash_dir.glob("conn-app-*.ips")}


def assert_no_panics_or_crashes(before_crashes: set[str], log_offset: int) -> None:
    after_crashes = snapshot_crash_reports()
    new_crashes = sorted(after_crashes - before_crashes)
    if new_crashes:
        raise AssertionError(f"new macOS crash reports written during E2E run: {new_crashes}")
    if APP_LOG.is_file():
        data = APP_LOG.read_bytes()[log_offset:].decode("utf-8", errors="replace")
        for needle in ("panicked at", "thread '", "there is no reactor running", "hover style already set"):
            if needle in data:
                raise AssertionError(f"panic marker {needle!r} found in {APP_LOG}:\n{data[-1500:]}")


def main() -> int:
    if not PORT_FILE.exists():
        print(f"error: automation port file not found: {PORT_FILE}", file=sys.stderr)
        return 1
    before_crashes = snapshot_crash_reports()
    log_offset = APP_LOG.stat().st_size if APP_LOG.is_file() else 0

    port = int(PORT_FILE.read_text().strip())
    client = AutomationClient(port)
    flows = [
        ("Cmd+K Command Palette theme switch + Escape", flow_command_palette_theme_switch),
        ("Thread context menu + Copy submenu hover/click + clipboard", flow_thread_context_menu_copy_submenu),
        ("Header Thread Details popover open + Escape dismiss", flow_header_thread_details_popover),
        ("Composer model picker + Plan toggle + PNG attachment upload", flow_composer_controls_and_image_attach),
        ("Cmd+, Settings › Scheduled tasks New/Cancel + Escape", flow_settings_scheduled_tasks),
        ("Database panel trigger click + Vault probe", flow_database_panel_click_and_vault),
        ("CEF Browser snapshot + click + eval", flow_browser_cef_snapshot_and_act),
    ]
    try:
        reset_ui(client)
        for name, fn in flows:
            t0 = time.monotonic()
            fn(client)
            dt = (time.monotonic() - t0) * 1000
            print(f"  PASS  {name} ({dt:.0f} ms)")
        client.call({"cmd": "close-panel"})
    finally:
        client.close()

    assert_no_panics_or_crashes(before_crashes, log_offset)
    print(f"All {len(flows)} E2E UI flows passed (zero panics / crash reports).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
