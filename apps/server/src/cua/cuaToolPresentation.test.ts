import * as NodeAssert from "node:assert/strict";

import { ThreadId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import {
  CUA_TOOL_TITLES,
  clearCuaToolContext,
  cuaToolPresentation,
  isCuaServerName,
  parseCuaToolName,
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

/** Tools advertised by Cua Driver 0.24 (`cua-driver mcp`), plus the history pair its instructions name. */
const CUA_DRIVER_TOOLS = [
  "bring_to_front",
  "browser_click",
  "browser_dialog",
  "browser_download",
  "browser_navigate",
  "browser_pointer",
  "browser_prepare",
  "browser_set_input_files",
  "browser_type",
  "check_for_update",
  "check_permissions",
  "click",
  "clipboard_read",
  "clipboard_write",
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
  "get_recording_state",
  "get_screen_size",
  "get_session",
  "get_session_state",
  "get_window_state",
  "health_report",
  "history_query",
  "history_status",
  "hotkey",
  "install_ffmpeg",
  "invoke_menu",
  "kill_app",
  "launch_app",
  "list_apps",
  "list_sessions",
  "list_windows",
  "move_cursor",
  "page",
  "press_key",
  "replay_trajectory",
  "right_click",
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

describe("CUA_TOOL_TITLES", () => {
  it("names every tool the driver exposes", () => {
    const missing = CUA_DRIVER_TOOLS.filter((tool) => !(tool in CUA_TOOL_TITLES));
    NodeAssert.deepEqual(missing, []);
    for (const tool of CUA_DRIVER_TOOLS) {
      const title = CUA_TOOL_TITLES[tool]!({ args: {}, appName: undefined, inProgress: false });
      NodeAssert.ok(title.length > 0 && !title.includes("_"), `${tool}: ${title}`);
    }
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
