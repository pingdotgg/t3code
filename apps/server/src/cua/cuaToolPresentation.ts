import type {
  ThreadId,
  ToolActivityIcon,
  ToolActivityNativeAppReference,
  ToolActivitySource,
} from "@t3tools/contracts";

import { CUA_MCP_SERVER_NAME } from "./cuaMcpServer.ts";

/**
 * Shared presentation for Cua Driver tool calls, so every provider renders
 * them like Codex computer use: a "computer" surface, the target app's icon,
 * and a human title. Cua addresses apps by pid, so the directory learns
 * pid-to-app mappings from discovery results and resolves later calls.
 */
export interface CuaToolPresentation {
  readonly title: string;
  readonly toolSurface: "computer";
  readonly toolIcon?: ToolActivityIcon;
  readonly toolSource: ToolActivitySource;
}

export interface CuaApp {
  readonly name?: string;
  readonly bundleId?: string;
}

const SERVER_PATTERN = CUA_MCP_SERVER_NAME.replace(/-/gu, "[-_]");
// Claude: mcp__cua-driver__click. OpenCode: cua-driver_click. ACP titles vary:
// "cua-driver/click", "cua-driver: click", "cua-driver.click".
const TOOL_NAME_PATTERN = new RegExp(
  `(?:^|[\\s(\`"'])(?:mcp__)?${SERVER_PATTERN}\\s*(?:__|_|/|:|\\.|\\s)\\s*([A-Za-z][A-Za-z0-9_]*)`,
  "u",
);

/** The Cua tool a provider-formatted tool name or title refers to, if any. */
export function parseCuaToolName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tool = TOOL_NAME_PATTERN.exec(value)?.[1];
  return tool ? tool.toLowerCase() : undefined;
}

export function isCuaServerName(server: string | undefined): boolean {
  return server?.trim().toLowerCase().replace(/_/gu, "-") === CUA_MCP_SERVER_NAME;
}

const MAX_THREADS = 256;
const MAX_APPS_PER_THREAD = 128;

interface ThreadDirectory {
  readonly byPid: Map<number, CuaApp>;
  lastApp: CuaApp | undefined;
}

const directories = new Map<ThreadId, ThreadDirectory>();

function directoryFor(threadId: ThreadId): ThreadDirectory {
  const existing = directories.get(threadId);
  if (existing) {
    // Refresh insertion order so the busiest threads survive eviction.
    directories.delete(threadId);
    directories.set(threadId, existing);
    return existing;
  }
  while (directories.size >= MAX_THREADS) {
    const oldest = directories.keys().next().value;
    if (oldest === undefined) break;
    directories.delete(oldest);
  }
  const created: ThreadDirectory = { byPid: new Map(), lastApp: undefined };
  directories.set(threadId, created);
  return created;
}

export function clearCuaToolContext(threadId: ThreadId): void {
  directories.delete(threadId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asPid(value: unknown): number | undefined {
  const pid = typeof value === "string" ? Number(value) : value;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function asText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

const asAppName = (value: unknown) => asText(value, 160);
const asBundleId = (value: unknown) => {
  const id = asText(value, 512);
  return id && /^[A-Za-z0-9._-]+$/u.test(id) ? id : undefined;
};

/** Accepts tool result text, MCP content arrays, or already-parsed objects. */
function parseResult(result: unknown): unknown {
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as unknown;
    } catch {
      return undefined;
    }
  }
  const record = asRecord(result);
  if (record?.structuredContent !== undefined) return record.structuredContent;
  const content = Array.isArray(record?.content) ? record.content : undefined;
  if (content) {
    for (const entry of content) {
      const item = asRecord(entry);
      if (item?.type === "text" && typeof item.text === "string") {
        const parsed = parseResult(item.text);
        if (parsed !== undefined) return parsed;
      }
    }
    return undefined;
  }
  return result;
}

function rememberApp(directory: ThreadDirectory, pid: number | undefined, app: CuaApp): CuaApp {
  if (pid === undefined) return app;
  const merged = { ...directory.byPid.get(pid), ...app };
  if (!directory.byPid.has(pid)) {
    while (directory.byPid.size >= MAX_APPS_PER_THREAD) {
      const oldest = directory.byPid.keys().next().value;
      if (oldest === undefined) break;
      directory.byPid.delete(oldest);
    }
  }
  directory.byPid.set(pid, merged);
  return merged;
}

function learnFromRecord(directory: ThreadDirectory, record: Record<string, unknown>): void {
  const name = asAppName(record.app_name) ?? asAppName(record.name);
  const bundleId = asBundleId(record.bundle_id);
  if (!name && !bundleId) return;
  rememberApp(directory, asPid(record.pid), {
    ...(name ? { name } : {}),
    ...(bundleId ? { bundleId } : {}),
  });
}

/**
 * Records app identities found in a tool result. `list_apps` and
 * `list_windows` return arrays; `launch_app` and window-state results
 * describe one app at the top level.
 */
export function rememberCuaToolResult(
  threadId: ThreadId,
  toolName: string,
  args: unknown,
  result: unknown,
): void {
  const parsed = asRecord(parseResult(result));
  if (!parsed) return;
  const directory = directoryFor(threadId);
  for (const value of Object.values(parsed)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value.slice(0, MAX_APPS_PER_THREAD)) {
      const record = asRecord(entry);
      if (record) learnFromRecord(directory, record);
    }
  }
  learnFromRecord(directory, parsed);
  const nested = asRecord(parsed.app) ?? asRecord(parsed.window);
  if (nested) learnFromRecord(directory, nested);
  // launch_app answers for the bundle it was asked to start.
  const requestedBundleId = asBundleId(asRecord(args)?.bundle_id);
  const pid = asPid(parsed.pid);
  if (requestedBundleId && pid !== undefined && toolName === "launch_app") {
    rememberApp(directory, pid, { bundleId: requestedBundleId });
  }
}

function humanizeBundleId(bundleId: string): string | undefined {
  const tail = bundleId.split(".").at(-1);
  return tail && /^[A-Za-z]/u.test(tail) ? tail.replace(/[-_]/gu, " ") : undefined;
}

function resolveApp(
  threadId: ThreadId,
  args: Record<string, unknown> | undefined,
): CuaApp | undefined {
  const directory = directories.get(threadId);
  const pid = asPid(args?.pid);
  const bundleId = asBundleId(args?.bundle_id);
  const name = asAppName(args?.app_name) ?? asAppName(args?.app);
  const known = pid !== undefined ? directory?.byPid.get(pid) : undefined;
  const app: CuaApp = {
    ...known,
    ...(bundleId ? { bundleId } : {}),
    ...(name ? { name } : {}),
  };
  if (app.name || app.bundleId) {
    if (directory) {
      if (pid !== undefined) rememberApp(directory, pid, app);
      directory.lastApp = app;
    }
    return app;
  }
  return undefined;
}

const TOOLS_WITHOUT_APP = new Set([
  "list_apps",
  "get_desktop_state",
  "get_screen_size",
  "get_cursor_position",
  "check_permissions",
  "health_report",
  "check_for_update",
  "install_ffmpeg",
  "start_session",
  "end_session",
  "get_session",
  "get_session_state",
  "list_sessions",
  "escalate_session",
  "get_config",
  "set_config",
  "get_agent_cursor_state",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "clipboard_read",
  "clipboard_write",
  "start_recording",
  "stop_recording",
  "get_recording_state",
  "replay_trajectory",
]);

function humanizeTool(tool: string, inProgress: boolean): string {
  const words = tool.split("_").filter((word) => word.length > 0);
  const verb = words[0] ?? tool;
  const rest = words.slice(1).join(" ");
  const progressive = inProgress
    ? verb.endsWith("e")
      ? `${verb.slice(0, -1)}ing`
      : `${verb}ing`
    : verb.endsWith("e")
      ? `${verb}d`
      : `${verb}ed`;
  const label = `${progressive}${rest ? ` ${rest}` : ""}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function keyLabel(keys: unknown): string | undefined {
  const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : [];
  const labels = list
    .map((key) => (typeof key === "string" ? key.trim() : ""))
    .filter((key) => key.length > 0 && key.length <= 24)
    .map((key) => {
      const lower = key.toLowerCase();
      if (lower === "cmd" || lower === "command" || lower === "meta") return "⌘";
      if (lower === "shift") return "⇧";
      if (lower === "alt" || lower === "option") return "⌥";
      if (lower === "ctrl" || lower === "control") return "⌃";
      if (lower === "enter" || lower === "return") return "Return";
      if (lower === "esc" || lower === "escape") return "Esc";
      return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
    });
  if (labels.length === 0 || labels.length > 4) return undefined;
  return labels.join(labels.every((label) => label.length === 1) ? "" : "+");
}

function cuaToolTitle(
  tool: string,
  args: Record<string, unknown> | undefined,
  appName: string | undefined,
  inProgress: boolean,
): string {
  const withApp = (label: string) => (appName ? `${label} in ${appName}` : label);
  const looked = appName
    ? `${inProgress ? "Looking at" : "Looked at"} ${appName}`
    : inProgress
      ? "Looking at the screen"
      : "Looked at the screen";
  switch (tool) {
    case "list_apps":
      return inProgress ? "Listing apps" : "Listed apps";
    case "list_windows":
      return withApp(inProgress ? "Listing windows" : "Listed windows");
    case "launch_app":
      return appName
        ? `${inProgress ? "Launching" : "Launched"} ${appName}`
        : inProgress
          ? "Launching app"
          : "Launched app";
    case "kill_app":
      return appName
        ? `${inProgress ? "Quitting" : "Quit"} ${appName}`
        : inProgress
          ? "Quitting app"
          : "Quit app";
    case "bring_to_front":
      return appName
        ? `${inProgress ? "Focusing" : "Focused"} ${appName}`
        : inProgress
          ? "Focusing window"
          : "Focused window";
    case "get_window_state":
    case "get_desktop_state":
    case "get_accessibility_tree":
    case "get_browser_state":
    case "verify_state":
    case "get_screen_size":
    case "get_cursor_position":
      return looked;
    case "click":
      return withApp(inProgress ? "Clicking" : "Clicked");
    case "double_click":
      return withApp(inProgress ? "Double-clicking" : "Double-clicked");
    case "right_click":
      return withApp(inProgress ? "Right-clicking" : "Right-clicked");
    case "drag":
      return withApp(inProgress ? "Dragging" : "Dragged");
    case "move_cursor":
      return withApp(inProgress ? "Moving cursor" : "Moved cursor");
    case "scroll": {
      const direction = asText(args?.direction, 16)?.toLowerCase();
      return withApp(`${inProgress ? "Scrolling" : "Scrolled"}${direction ? ` ${direction}` : ""}`);
    }
    case "type_text":
    case "browser_type":
      return withApp(inProgress ? "Typing text" : "Typed text");
    case "set_value":
      return withApp(inProgress ? "Setting value" : "Set value");
    case "press_key":
    case "hotkey": {
      const keys = keyLabel(args?.keys ?? args?.key);
      return withApp(`${inProgress ? "Pressing" : "Pressed"} ${keys ?? "key"}`);
    }
    case "invoke_menu":
      return withApp(inProgress ? "Choosing menu item" : "Chose menu item");
    case "set_window_frame":
      return withApp(inProgress ? "Resizing window" : "Resized window");
    case "zoom":
      return withApp(inProgress ? "Zooming" : "Zoomed");
    case "page":
      return withApp(inProgress ? "Reading page" : "Read page");
    case "browser_navigate": {
      const url = asText(args?.url, 200);
      return withApp(`${inProgress ? "Opening" : "Opened"} ${url ?? "page"}`);
    }
    case "browser_click":
    case "browser_pointer":
      return withApp(inProgress ? "Clicking" : "Clicked");
    case "browser_prepare":
      return withApp(inProgress ? "Preparing browser" : "Prepared browser");
    case "clipboard_read":
      return inProgress ? "Reading clipboard" : "Read clipboard";
    case "clipboard_write":
      return inProgress ? "Writing clipboard" : "Wrote clipboard";
    case "start_recording":
      return inProgress ? "Starting recording" : "Started recording";
    case "stop_recording":
      return inProgress ? "Stopping recording" : "Stopped recording";
    case "check_permissions":
      return inProgress ? "Checking permissions" : "Checked permissions";
    case "start_session":
    case "end_session":
    case "get_session":
    case "get_session_state":
    case "list_sessions":
    case "escalate_session":
    case "get_config":
    case "set_config":
    case "get_agent_cursor_state":
    case "set_agent_cursor_enabled":
    case "set_agent_cursor_motion":
    case "set_agent_cursor_theme":
    case "health_report":
    case "check_for_update":
    case "install_ffmpeg":
    case "get_recording_state":
      return inProgress ? "Configuring computer use" : "Configured computer use";
    default:
      return withApp(humanizeTool(tool, inProgress));
  }
}

function nativeApp(app: CuaApp): ToolActivityNativeAppReference | undefined {
  if (app.bundleId) return { _tag: "app-id", appId: app.bundleId };
  if (app.name) return { _tag: "display-name", displayName: app.name };
  return undefined;
}

/**
 * Presentation for one Cua tool call. `rawToolName` may be a provider tool
 * name or an ACP title; returns undefined for anything that is not Cua.
 */
export function cuaToolPresentation(input: {
  readonly threadId: ThreadId;
  readonly rawToolName: string | undefined;
  readonly args: unknown;
  readonly status: "inProgress" | "completed" | "failed";
}): CuaToolPresentation | undefined {
  const tool = parseCuaToolName(input.rawToolName);
  if (!tool) return undefined;
  const args = asRecord(input.args);
  const app = TOOLS_WITHOUT_APP.has(tool) ? undefined : resolveApp(input.threadId, args);
  const appName = app?.name ?? (app?.bundleId ? humanizeBundleId(app.bundleId) : undefined);
  const reference = app ? nativeApp(app) : undefined;
  const icon = reference ? ({ _tag: "native-app", app: reference } as const) : undefined;
  return {
    title: cuaToolTitle(tool, args, appName, input.status === "inProgress"),
    toolSurface: "computer",
    ...(icon ? { toolIcon: icon } : {}),
    toolSource: {
      key: app?.bundleId
        ? `native-app:${app.bundleId.toLowerCase()}`
        : appName
          ? `native-app-name:${appName.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`
          : "computer-use",
      name: appName ?? "Computer Use",
      kind: "computer",
      ...(icon ? { icon } : {}),
    },
  };
}
