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

/** The window the agent addressed most recently, for the live preview. */
export interface CuaWindowTarget {
  readonly pid: number;
  readonly windowId: bigint;
}

interface ThreadDirectory {
  readonly byPid: Map<number, CuaApp>;
  lastApp: CuaApp | undefined;
  lastWindow: CuaWindowTarget | undefined;
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
  const created: ThreadDirectory = { byPid: new Map(), lastApp: undefined, lastWindow: undefined };
  directories.set(threadId, created);
  return created;
}

export function clearCuaToolContext(threadId: ThreadId): void {
  directories.delete(threadId);
}

/** Last window the agent targeted in this thread, if any tool call named one. */
export function readCuaWindowTarget(threadId: ThreadId): CuaWindowTarget | undefined {
  return directories.get(threadId)?.lastWindow;
}

function asWindowId(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value > 0n ? value : undefined;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) {
    const id = BigInt(value);
    return id > 0n ? id : undefined;
  }
  return undefined;
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
  const windowId = asWindowId(args?.window_id);
  if (pid !== undefined && windowId !== undefined) {
    directoryFor(threadId).lastWindow = { pid, windowId };
  }
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
  // Element tokens and session labels address a window the agent already
  // resolved, so the app it last touched in this thread is the target.
  return pid === undefined ? directory?.lastApp : undefined;
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

interface TitleInput {
  readonly args: Record<string, unknown> | undefined;
  readonly appName: string | undefined;
  readonly inProgress: boolean;
}

const verb = (inProgress: boolean, doing: string, done: string) => (inProgress ? doing : done);

/** Every tool Cua Driver 0.24 exposes; the test pins this list against the server's catalogue. */
export const CUA_TOOL_TITLES: Readonly<Record<string, (input: TitleInput) => string>> = (() => {
  const withApp = (label: string, appName: string | undefined) =>
    appName ? `${label} in ${appName}` : label;
  const inApp = (doing: string, done: string) => (input: TitleInput) =>
    withApp(verb(input.inProgress, doing, done), input.appName);
  const onApp = (doing: string, done: string, fallback: string) => (input: TitleInput) =>
    input.appName
      ? `${verb(input.inProgress, doing, done)} ${input.appName}`
      : `${verb(input.inProgress, doing, done)} ${fallback}`;
  const plain = (doing: string, done: string) => (input: TitleInput) =>
    verb(input.inProgress, doing, done);
  const looked = (input: TitleInput) =>
    input.appName
      ? `${verb(input.inProgress, "Looking at", "Looked at")} ${input.appName}`
      : verb(input.inProgress, "Looking at the screen", "Looked at the screen");
  const configured = plain("Configuring computer use", "Configured computer use");
  return {
    list_apps: plain("Listing apps", "Listed apps"),
    list_windows: inApp("Listing windows", "Listed windows"),
    launch_app: onApp("Launching", "Launched", "app"),
    kill_app: onApp("Quitting", "Quit", "app"),
    bring_to_front: onApp("Focusing", "Focused", "window"),
    get_window_state: looked,
    get_desktop_state: looked,
    get_accessibility_tree: looked,
    get_browser_state: looked,
    verify_state: looked,
    get_screen_size: looked,
    get_cursor_position: looked,
    click: inApp("Clicking", "Clicked"),
    double_click: inApp("Double-clicking", "Double-clicked"),
    right_click: inApp("Right-clicking", "Right-clicked"),
    drag: inApp("Dragging", "Dragged"),
    move_cursor: inApp("Moving cursor", "Moved cursor"),
    scroll: (input) => {
      const direction = asText(input.args?.direction, 16)?.toLowerCase();
      return withApp(
        `${verb(input.inProgress, "Scrolling", "Scrolled")}${direction ? ` ${direction}` : ""}`,
        input.appName,
      );
    },
    type_text: inApp("Typing text", "Typed text"),
    browser_type: inApp("Typing text", "Typed text"),
    set_value: inApp("Setting value", "Set value"),
    press_key: (input) =>
      withApp(
        `${verb(input.inProgress, "Pressing", "Pressed")} ${keyLabel(input.args?.keys ?? input.args?.key) ?? "key"}`,
        input.appName,
      ),
    hotkey: (input) =>
      withApp(
        `${verb(input.inProgress, "Pressing", "Pressed")} ${keyLabel(input.args?.keys ?? input.args?.key) ?? "shortcut"}`,
        input.appName,
      ),
    invoke_menu: inApp("Choosing menu item", "Chose menu item"),
    set_window_frame: inApp("Resizing window", "Resized window"),
    zoom: inApp("Zooming", "Zoomed"),
    page: inApp("Reading page", "Read page"),
    browser_navigate: (input) =>
      withApp(
        `${verb(input.inProgress, "Opening", "Opened")} ${asText(input.args?.url, 200) ?? "page"}`,
        input.appName,
      ),
    browser_click: inApp("Clicking", "Clicked"),
    browser_pointer: inApp("Clicking", "Clicked"),
    browser_prepare: inApp("Preparing browser", "Prepared browser"),
    browser_dialog: inApp("Answering dialog", "Answered dialog"),
    browser_download: inApp("Downloading file", "Downloaded file"),
    browser_set_input_files: inApp("Attaching files", "Attached files"),
    clipboard_read: plain("Reading clipboard", "Read clipboard"),
    clipboard_write: plain("Writing clipboard", "Wrote clipboard"),
    start_recording: plain("Starting recording", "Started recording"),
    stop_recording: plain("Stopping recording", "Stopped recording"),
    get_recording_state: plain("Checking recording", "Checked recording"),
    replay_trajectory: plain("Replaying actions", "Replayed actions"),
    check_permissions: plain("Checking permissions", "Checked permissions"),
    history_status: plain("Checking history", "Checked history"),
    history_query: plain("Searching history", "Searched history"),
    start_session: plain("Starting computer use session", "Started computer use session"),
    end_session: plain("Ending computer use session", "Ended computer use session"),
    escalate_session: plain("Escalating computer use session", "Escalated computer use session"),
    get_session: configured,
    get_session_state: configured,
    list_sessions: configured,
    get_config: configured,
    set_config: configured,
    get_agent_cursor_state: configured,
    set_agent_cursor_enabled: configured,
    set_agent_cursor_motion: configured,
    set_agent_cursor_theme: configured,
    health_report: configured,
    check_for_update: configured,
    install_ffmpeg: configured,
  };
})();

function cuaToolTitle(
  tool: string,
  args: Record<string, unknown> | undefined,
  appName: string | undefined,
  inProgress: boolean,
): string {
  const known = CUA_TOOL_TITLES[tool];
  if (known) return known({ args, appName, inProgress });
  const label = humanizeTool(tool, inProgress);
  return appName ? `${label} in ${appName}` : label;
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
