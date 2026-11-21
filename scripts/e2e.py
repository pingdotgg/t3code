#!/usr/bin/env python3
"""End-to-end UI flow test suite for a live `Conn GPUI.app` window.

Drives real GPUI mouse clicks, keystrokes, text input, and CEF DOM actions over
the `--features automation` loopback socket (`CONN_GPUI_AUTOMATION`), asserting
against the live AccessKit tree, app state dump, and Unix control socket.

Usage:
  CARGO_FLAGS="--features cef" ./scripts/run-app.sh --applications
  python3 scripts/e2e.py
"""
from __future__ import annotations

import json
import os
import socket
import sys
import time
from pathlib import Path

PORT_FILE = Path(os.environ.get("CONN_GPUI_AUTOMATION", "/tmp/conn-gpui-dev/automation-port"))


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
    """Close any open modal and give the main shell active GPUI focus."""
    for _ in range(3):
        state = client.call({"cmd": "dump"})
        if not state.get("settings") and not state.get("palette"):
            break
        client.call({"cmd": "press", "key": "escape"})
        time.sleep(0.1)
    client.call({"cmd": "wait", "axId": "rail.all-projects", "timeoutMs": 3000})
    client.call({"cmd": "click", "axId": "rail.all-projects"})


def flow_command_palette_theme_switch(client: AutomationClient) -> None:
    initial = client.call({"cmd": "dump"})
    original_theme = initial["theme"]
    target_theme = "dark-ocean" if original_theme != "dark-ocean" else "t3-code-light"
    target_query = "Dark Ocean" if target_theme == "dark-ocean" else "T3 Code Light"

    # Real Cmd+K keystroke opens the palette.
    client.call({"cmd": "press", "key": "cmd-k"})
    client.call({"cmd": "wait", "axId": "palette.modal", "timeoutMs": 3000})
    client.call({"cmd": "type", "text": target_query})
    client.call({"cmd": "press", "key": "enter"})
    client.call({"cmd": "wait", "absentAxId": "palette.modal", "timeoutMs": 3000})

    after = client.call({"cmd": "dump"})
    assert_eq(after["theme"], target_theme, "Cmd+K theme switch via real typing + Enter")

    # Open again via Cmd+K and dismiss with Escape.
    client.call({"cmd": "press", "key": "cmd-k"})
    client.call({"cmd": "wait", "axId": "palette.modal", "timeoutMs": 3000})
    client.call({"cmd": "press", "key": "escape"})
    client.call({"cmd": "wait", "absentAxId": "palette.modal", "timeoutMs": 3000})

    # Restore original theme so the user's window stays clean.
    client.call({"cmd": "theme", "id": original_theme})


def flow_settings_scheduled_tasks(client: AutomationClient) -> None:
    # Real Cmd+, opens Settings modal.
    client.call({"cmd": "press", "key": "cmd-,"})
    client.call({"cmd": "wait", "axId": "settings.modal", "timeoutMs": 3000})

    # Real mouse click on "Scheduled tasks" nav tab.
    client.call({"cmd": "click", "axId": "settings.nav.scheduled tasks"})
    client.call({"cmd": "wait", "axId": "settings.scheduled.new", "timeoutMs": 3000})

    # Real mouse click on "New task" opens the inline task editor.
    client.call({"cmd": "click", "axId": "settings.scheduled.new"})
    client.call({"cmd": "wait", "axId": "settings.scheduled.save", "timeoutMs": 3000})

    # Cancel back to the list, then press Escape to close Settings.
    client.call({"cmd": "click", "axId": "settings.scheduled.cancel"})
    client.call({"cmd": "wait", "axId": "settings.scheduled.new", "timeoutMs": 3000})
    client.call({"cmd": "press", "key": "escape"})
    client.call({"cmd": "wait", "absentAxId": "settings.modal", "timeoutMs": 3000})


def flow_database_panel_click_and_vault(client: AutomationClient) -> None:
    client.call({"cmd": "panel", "tab": "Database"})
    client.call({"cmd": "wait", "axId": "database.connection.trigger", "timeoutMs": 3000})
    client.call({"cmd": "click", "axId": "database.connection.trigger"})
    # Give the async Vault bridge a brief moment to respond, then check AccessKit labels.
    time.sleep(0.5)
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


def main() -> int:
    if not PORT_FILE.exists():
        print(f"error: automation port file not found: {PORT_FILE}", file=sys.stderr)
        return 1
    port = int(PORT_FILE.read_text().strip())
    client = AutomationClient(port)
    flows = [
        ("Cmd+K Command Palette theme switch + Escape", flow_command_palette_theme_switch),
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
        # Leave Database panel open cleanly after the suite finishes.
        client.call({"cmd": "panel", "tab": "Database"})
    finally:
        client.close()
    print(f"All {len(flows)} E2E UI flows passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
