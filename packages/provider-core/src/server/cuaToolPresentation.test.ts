import * as NodeAssert from "node:assert/strict";

import { ThreadId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import {
  CUA_TOOL_TITLES,
  clearCuaToolContext,
  cuaToolPresentation,
  isCuaServerName,
  parseCuaToolName,
  readCuaWindowTarget,
  rememberCuaToolResult,
} from "./cuaToolPresentation.ts";

const threadId = ThreadId.make("thread-cua-presentation");

describe("parseCuaToolName", () => {
  it.each([
    ["mcp__cua-driver__click", "click"],
    ["cua-driver_type_text", "type_text"],
    ["cua-driver/get_window_state", "get_window_state"],
    ["cua-driver: list_apps", "list_apps"],
    ["Run cua_driver.scroll", "scroll"],
  ])("reads %s as %s", (raw, expected) => {
    NodeAssert.equal(parseCuaToolName(raw), expected);
  });

  it("ignores other servers and unrelated titles", () => {
    NodeAssert.equal(parseCuaToolName("mcp__linear__create_issue"), undefined);
    NodeAssert.equal(parseCuaToolName("Bash"), undefined);
    NodeAssert.equal(parseCuaToolName(undefined), undefined);
    NodeAssert.equal(isCuaServerName("cua-driver"), true);
    NodeAssert.equal(isCuaServerName("cua_driver"), true);
    NodeAssert.equal(isCuaServerName("node_repl"), false);
  });
});

describe("cuaToolPresentation", () => {
  it("retains a discovered app's display name and icon identity in window listings", () => {
    clearCuaToolContext(threadId);
    rememberCuaToolResult(
      threadId,
      "list_apps",
      {},
      { apps: [{ pid: 12, name: "Helium", bundle_id: "net.imput.helium" }] },
    );
    rememberCuaToolResult(
      threadId,
      "list_windows",
      {},
      { windows: [{ pid: 12, window_id: 34, app_name: "chrome.exe", title: "Releases - Helium" }] },
    );
    const presentation = cuaToolPresentation({
      threadId,
      rawToolName: "cua-driver/get_window_state",
      args: { pid: 12, window_id: 34 },
      status: "completed",
    });
    NodeAssert.equal(presentation?.title, "Looked at Helium");
    NodeAssert.deepEqual(presentation?.toolIcon, {
      _tag: "native-app",
      app: { _tag: "app-id", appId: "net.imput.helium" },
    });
  });

  it("keeps identities for Windows apps sharing a host PID separate", () => {
    clearCuaToolContext(threadId);
    rememberCuaToolResult(
      threadId,
      "launch_app",
      { name: "Calculator" },
      {
        pid: 11804,
        name: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        bundle_id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        windows: [{ window_id: 10, title: "Calculator" }],
      },
    );
    rememberCuaToolResult(
      threadId,
      "list_windows",
      {},
      {
        windows: [
          { pid: 11804, window_id: 10, app_name: "ApplicationFrameHost.exe", title: "Calculator" },
          { pid: 11804, window_id: 20, app_name: "ApplicationFrameHost.exe", title: "Settings" },
        ],
      },
    );
    for (const [windowId, expected] of [
      [10, "Calculator"],
      [20, "Settings"],
      [10, "Calculator"],
    ] as const) {
      rememberCuaToolResult(
        threadId,
        "get_window_state",
        { pid: 11804, window_id: windowId },
        {
          pid: 11804,
          window_id: windowId,
          app_name: "ApplicationFrameHost.exe",
          window_title: expected,
        },
      );
      const viewed = cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args:
          windowId === 20
            ? { target: { kind: "window", pid: 11804, window_id: windowId } }
            : { pid: 11804, window_id: windowId },
        status: "completed",
      });
      NodeAssert.equal(viewed?.title, `Looked at ${expected}`);
      const clicked = cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/click",
        args: { pid: 11804, element_token: "snapshot:1" },
        status: "completed",
      });
      NodeAssert.equal(clicked?.title, `Clicked in ${expected}`);
      NodeAssert.deepEqual(clicked?.toolIcon, {
        _tag: "native-app",
        app:
          expected === "Calculator"
            ? { _tag: "app-id", appId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" }
            : { _tag: "display-name", displayName: "Settings" },
      });
    }
  });

  it("resolves apps by pid from earlier discovery results", () => {
    clearCuaToolContext(threadId);
    rememberCuaToolResult(
      threadId,
      "list_apps",
      {},
      JSON.stringify({
        apps: [{ pid: 1246, name: "Helium", bundle_id: "net.imput.helium", running: true }],
      }),
    );
    const clicked = cuaToolPresentation({
      threadId,
      rawToolName: "mcp__cua-driver__click",
      args: { pid: 1246, window_id: 59, x: 10, y: 20 },
      status: "completed",
    });
    NodeAssert.deepEqual(clicked, {
      title: "Clicked in Helium",
      toolSurface: "computer",
      toolIcon: { _tag: "native-app", app: { _tag: "app-id", appId: "net.imput.helium" } },
      toolSource: {
        key: "native-app:net.imput.helium",
        name: "Helium",
        kind: "computer",
        icon: { _tag: "native-app", app: { _tag: "app-id", appId: "net.imput.helium" } },
      },
    });
    NodeAssert.equal(
      cuaToolPresentation({
        threadId,
        rawToolName: "mcp__cua-driver__hotkey",
        args: { pid: 1246, keys: ["cmd", "t"] },
        status: "inProgress",
      })?.title,
      "Pressing ⌘T in Helium",
    );
    NodeAssert.equal(
      cuaToolPresentation({
        threadId,
        rawToolName: "mcp__cua-driver__scroll",
        args: { pid: 1246, direction: "down" },
        status: "completed",
      })?.title,
      "Scrolled down in Helium",
    );
  });

  it("learns names from window listings and MCP content arrays", () => {
    clearCuaToolContext(threadId);
    rememberCuaToolResult(
      threadId,
      "list_windows",
      {},
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ windows: [{ window_id: 59, pid: 1246, app_name: "Helium" }] }),
          },
        ],
      },
    );
    const looked = cuaToolPresentation({
      threadId,
      rawToolName: "cua-driver_get_window_state",
      args: { pid: 1246, window_id: 59 },
      status: "completed",
    });
    NodeAssert.equal(looked?.title, "Looked at Helium");
    NodeAssert.deepEqual(looked?.toolIcon, {
      _tag: "native-app",
      app: { _tag: "display-name", displayName: "Helium" },
    });
    NodeAssert.equal(looked?.toolSource.key, "native-app-name:helium");
  });

  it("falls back to a generic computer-use source without an app", () => {
    clearCuaToolContext(threadId);
    const listing = cuaToolPresentation({
      threadId,
      rawToolName: "mcp__cua-driver__list_apps",
      args: {},
      status: "inProgress",
    });
    NodeAssert.equal(listing?.title, "Listing apps");
    NodeAssert.equal(listing?.toolIcon, undefined);
    NodeAssert.deepEqual(listing?.toolSource, {
      key: "computer-use",
      name: "Computer Use",
      kind: "computer",
    });
    const unknownPid = cuaToolPresentation({
      threadId,
      rawToolName: "mcp__cua-driver__click",
      args: { pid: 999 },
      status: "completed",
    });
    NodeAssert.equal(unknownPid?.title, "Clicked");
  });

  it("uses the requested bundle for launch_app before any listing", () => {
    clearCuaToolContext(threadId);
    const launching = cuaToolPresentation({
      threadId,
      rawToolName: "mcp__cua-driver__launch_app",
      args: { bundle_id: "com.apple.Safari" },
      status: "inProgress",
    });
    NodeAssert.equal(launching?.title, "Launching Safari");
    NodeAssert.deepEqual(launching?.toolIcon, {
      _tag: "native-app",
      app: { _tag: "app-id", appId: "com.apple.Safari" },
    });
    rememberCuaToolResult(
      threadId,
      "launch_app",
      { bundle_id: "com.apple.Safari" },
      JSON.stringify({ pid: 4321, name: "Safari" }),
    );
    NodeAssert.equal(
      cuaToolPresentation({
        threadId,
        rawToolName: "mcp__cua-driver__type_text",
        args: { pid: 4321, text: "hello" },
        status: "completed",
      })?.title,
      "Typed text in Safari",
    );
    NodeAssert.equal(
      cuaToolPresentation({
        threadId,
        rawToolName: "mcp__cua-driver__launch_app",
        args: { name: "/Applications/Visual Studio Code.app" },
        status: "inProgress",
      })?.title,
      "Launching Visual Studio Code",
    );
  });

  it("returns nothing for tools outside Cua", () => {
    NodeAssert.equal(
      cuaToolPresentation({
        threadId,
        rawToolName: "mcp__linear__create_issue",
        args: {},
        status: "completed",
      }),
      undefined,
    );
  });
});

/** Tools advertised by Cua Driver 0.38 (`cua-driver mcp`) on any platform. */
const CUA_DRIVER_TOOLS = [
  "bring_to_front",
  "browser_click",
  "browser_dialog",
  "browser_download",
  "browser_navigate",
  "browser_pointer",
  "browser_prepare",
  "browser_select",
  "browser_set_input_files",
  "browser_type",
  "check_for_update",
  "check_permissions",
  "click",
  "clipboard_read",
  "clipboard_write",
  "debug_window_info",
  "double_click",
  "drag",
  "end_session",
  "escalate_session",
  "get_accessibility_tree",
  "get_agent_cursor_state",
  "get_browser_state",
  "get_config",
  "get_cursor_position",
  "get_desktop_state",
  "get_guide",
  "get_recording_state",
  "get_screen_size",
  "get_session",
  "get_session_state",
  "get_window_state",
  "health_report",
  "hotkey",
  "install_extension",
  "install_ffmpeg",
  "invoke_menu",
  "kill_app",
  "launch_app",
  "list_apps",
  "list_sessions",
  "list_windows",
  "mouse_button_down",
  "mouse_button_up",
  "mouse_drag",
  "move_cursor",
  "page",
  "parallel_mouse_drag",
  "parse_visual_regions",
  "press_key",
  "replay_trajectory",
  "right_click",
  "run_script",
  "run_steps",
  "scroll",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "set_config",
  "set_value",
  "set_window_frame",
  "start_recording",
  "start_session",
  "stop_recording",
  "type_text",
  "verify_state",
  "zoom",
];

describe("readCuaWindowTarget", () => {
  it("keeps the capture target when restoring focus or a later tool fails", () => {
    clearCuaToolContext(threadId);
    cuaToolPresentation({
      threadId,
      rawToolName: "cua-driver/get_window_state",
      args: { pid: 42, window_id: 7 },
      status: "completed",
    });
    for (const status of ["inProgress", "completed"] as const) {
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/bring_to_front",
        args: { pid: 99, window_id: 8 },
        status,
      });
      NodeAssert.deepEqual(readCuaWindowTarget(threadId), { pid: 42, windowId: 7n });
    }
    cuaToolPresentation({
      threadId,
      rawToolName: "cua-driver/get_window_state",
      args: { pid: 99, window_id: 8 },
      status: "failed",
    });
    NodeAssert.deepEqual(readCuaWindowTarget(threadId), { pid: 42, windowId: 7n });
    clearCuaToolContext(threadId);
  });

  it("keeps display-only inspections from redirecting the preview", () => {
    clearCuaToolContext(threadId);
    for (const args of [
      { pid: 42, window_id: 7 },
      { pid: 99, window_id: 8, display_only: true },
    ]) {
      cuaToolPresentation({
        threadId,
        rawToolName: "cua-driver/get_window_state",
        args,
        status: "completed",
      });
    }
    NodeAssert.deepEqual(readCuaWindowTarget(threadId), { pid: 42, windowId: 7n });
  });
  it("remembers the last pid and window id a tool call addressed", () => {
    clearCuaToolContext(threadId);
    NodeAssert.equal(readCuaWindowTarget(threadId), undefined);
    cuaToolPresentation({
      threadId,
      rawToolName: "cua-driver/get_window_state",
      args: { pid: 42, window_id: "7" },
      status: "completed",
    });
    NodeAssert.deepEqual(readCuaWindowTarget(threadId), { pid: 42, windowId: 7n });
    cuaToolPresentation({
      threadId,
      rawToolName: "cua-driver/click",
      args: { pid: 42, element_token: "e1" },
      status: "completed",
    });
    NodeAssert.deepEqual(readCuaWindowTarget(threadId), { pid: 42, windowId: 7n });
    cuaToolPresentation({
      threadId,
      rawToolName: "cua-driver/click",
      args: { pid: 9, window_id: 0, x: 1, y: 1 },
      status: "completed",
    });
    NodeAssert.deepEqual(readCuaWindowTarget(threadId), { pid: 42, windowId: 7n });
    clearCuaToolContext(threadId);
    NodeAssert.equal(readCuaWindowTarget(threadId), undefined);
  });
});

describe("CUA_TOOL_TITLES", () => {
  it("names every tool the driver exposes", () => {
    const missing = CUA_DRIVER_TOOLS.filter((tool) => !(tool in CUA_TOOL_TITLES));
    NodeAssert.deepEqual(missing, []);
    for (const tool of CUA_DRIVER_TOOLS) {
      const title = CUA_TOOL_TITLES[tool]!({ args: {}, appName: undefined, inProgress: false });
      NodeAssert.ok(title.length > 0 && !title.includes("_"), `${tool}: ${title}`);
    }
  });

  it("names the app a run_steps batch targets through its last step", () => {
    clearCuaToolContext(threadId);
    rememberCuaToolResult(
      threadId,
      "list_apps",
      {},
      {
        apps: [{ pid: 512, name: "Safari", bundle_id: "com.apple.Safari" }],
      },
    );
    const presentation = cuaToolPresentation({
      threadId,
      rawToolName: "mcp__cua-driver__run_steps",
      args: {
        steps: [
          { action: "click", pid: 99 },
          { action: "type_text", pid: 512, window_id: 3 },
        ],
      },
      status: "completed",
    });
    NodeAssert.equal(presentation?.title, "Ran steps in Safari");
  });

  it("targets the last app in the thread when a call only carries an element token", () => {
    clearCuaToolContext(threadId);
    rememberCuaToolResult(
      threadId,
      "list_apps",
      {},
      '{"apps":[{"pid":1252,"name":"Calendar","bundle_id":"com.apple.iCal"}]}',
    );
    cuaToolPresentation({
      threadId,
      rawToolName: "mcp__cua-driver__get_window_state",
      args: { pid: 1252, window_id: 61 },
      status: "completed",
    });
    const clicked = cuaToolPresentation({
      threadId,
      rawToolName: "mcp__cua-driver__click",
      args: { element_token: "s00000001:119", session: "cal" },
      status: "failed",
    });
    NodeAssert.equal(clicked?.title, "Clicked in Calendar");
    NodeAssert.equal(clicked?.toolSource.key, "native-app:com.apple.ical");
  });
});
