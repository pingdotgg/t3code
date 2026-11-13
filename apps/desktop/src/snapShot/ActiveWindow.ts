// @effect-diagnostics nodeBuiltinImport:off -- This platform boundary asks the OS for its foreground window with Node.

import * as NodeChildProcess from "node:child_process";

import * as Schema from "effect/Schema";

import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";

/** id is CGWindowNumber on macOS or HWND on Windows, matching the capture backend. */
export type ActiveWindow = {
  readonly platform: "macos" | "windows";
  readonly id: number;
  readonly title: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly owner: {
    readonly name: string;
    readonly processId: number;
    readonly path: string;
    readonly bundleId?: string;
  };
};

const MAC_LOOKUP_TIMEOUT_MS = 5_000;

const MAC_HELPER_STRIP_MAX_THICKNESS_RATIO = 0.25;

const MAC_SHARING_INDICATOR_BUTTON = "WindowSharingSessionButton";

const MacActiveWindowLookup = Schema.Struct({
  owner: Schema.Struct({
    name: Schema.String,
    processId: Schema.Number,
    path: Schema.String,
    bundleId: Schema.String,
  }),
  windows: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      title: Schema.String,
      bounds: Schema.Struct({
        x: Schema.Number,
        y: Schema.Number,
        width: Schema.Number,
        height: Schema.Number,
      }),
      alpha: Schema.Number,
    }),
  ),
  accessibilityWindows: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        onlyButton: Schema.optionalKey(
          Schema.Struct({ title: Schema.String, identifier: Schema.String }),
        ),
      }),
    ),
  ),
});
const decodeMacActiveWindowLookup = Schema.decodeUnknownSync(
  Schema.fromJsonString(MacActiveWindowLookup),
);

const MAC_LOOKUP_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
function readAccessibilityWindows(pid, deadline) {
  if (Date.now() >= deadline) return undefined;
  if (!$.AXIsProcessTrusted()) return undefined;
  $.AXUIElementSetMessagingTimeout($.AXUIElementCreateSystemWide(), 0.25);
  const copy = (element, name) => {
    if (Date.now() >= deadline) throw new Error("accessibility budget exhausted");
    const value = Ref();
    const error = $.AXUIElementCopyAttributeValue(element, $(name), value);
    if (error === -25204) throw new Error("accessibility timed out");
    return error === 0 ? ObjC.castRefToObject(value[0]) : undefined;
  };
  const text = (element, name) => {
    const value = copy(element, name);
    return value === undefined ? "" : String(ObjC.unwrap(value) || "");
  };
  const list = copy($.AXUIElementCreateApplication(pid), "AXWindows");
  if (list === undefined) return undefined;
  const windows = [];
  for (let i = 0; i < Number(list.count); i++) {
    const window = list.objectAtIndex(i);
    const title = copy(window, "AXTitle");
    if (title === undefined) throw new Error("accessibility window title unavailable");
    const children = copy(window, "AXChildren");
    const child =
      children !== undefined && Number(children.count) === 1 ? children.objectAtIndex(0) : undefined;
    windows.push({
      title: String(ObjC.unwrap(title) || ""),
      ...(child !== undefined && text(child, "AXRole") === "AXButton"
        ? {
            onlyButton: {
              title: text(child, "AXTitle"),
              identifier: text(child, "AXIdentifier"),
            },
          }
        : {}),
    });
  }
  return windows;
}
function run() {
  // Leave time to return the CG result when accessibility calls are slow.
  const accessibilityDeadline = Date.now() + 2000;
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (app.isNil()) return "";
  const pid = app.processIdentifier;
  let ownerName = String(app.localizedName.js || "");
  const list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID,
  );
  $.CFMakeCollectable(list);
  const count = $.CFArrayGetCount(list);
  const windows = [];
  for (let i = 0; i < count; i++) {
    const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
    if (w.objectForKey("kCGWindowOwnerPID").js !== pid) continue;
    if (w.objectForKey("kCGWindowLayer").js !== 0) continue;
    if (!ownerName) {
      ownerName = String(ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || "");
    }
    const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    windows.push({
      id: w.objectForKey("kCGWindowNumber").js,
      title: String(ObjC.unwrap(w.objectForKey("kCGWindowName")) || ""),
      bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height },
      alpha: w.objectForKey("kCGWindowAlpha").js,
    });
  }
  let accessibilityWindows;
  try {
    accessibilityWindows = readAccessibilityWindows(pid, accessibilityDeadline);
  } catch (error) {}
  return JSON.stringify({
    accessibilityWindows,
    owner: {
      name: ownerName,
      processId: pid,
      path: String(app.bundleURL.path.js || ""),
      bundleId: String(app.bundleIdentifier.js || ""),
    },
    windows,
  });
}`;

function runMacLookup(): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_LOOKUP_SCRIPT],
      { timeout: MAC_LOOKUP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

type MacAccessibilityWindow = NonNullable<
  (typeof MacActiveWindowLookup.Type)["accessibilityWindows"]
>[number];

function isMacSharingIndicator(window: MacAccessibilityWindow): boolean {
  const button = window.onlyButton;
  return (
    button?.title === MAC_SHARING_INDICATOR_BUTTON ||
    button?.identifier === MAC_SHARING_INDICATOR_BUTTON
  );
}

// macOS puts a titled indicator window in front of a window another app is capturing.
// AX has no public CGWindowID, so only match titles unambiguous in both window lists.
function macSharingIndicatorTitles(
  accessibilityWindows: ReadonlyArray<MacAccessibilityWindow>,
  visibleTitles: ReadonlyArray<string>,
): ReadonlySet<string> {
  const titles = new Set(
    accessibilityWindows
      .filter((window) => window.title !== "" && isMacSharingIndicator(window))
      .map((window) => window.title),
  );
  for (const window of accessibilityWindows) {
    if (!isMacSharingIndicator(window)) titles.delete(window.title);
  }
  for (const title of titles) {
    if (visibleTitles.filter((candidate) => candidate === title).length !== 1) titles.delete(title);
  }
  return titles;
}

async function macActiveWindow(): Promise<ActiveWindow | undefined> {
  const output = (await runMacLookup()).trim();
  if (!output) return undefined;
  const lookup = decodeMacActiveWindowLookup(output);
  const candidates = lookup.windows.filter(
    (window) => window.alpha > 0 && window.bounds.width > 0 && window.bounds.height > 0,
  );
  const sharingIndicatorTitles = macSharingIndicatorTitles(
    lookup.accessibilityWindows ?? [],
    candidates.map((window) => window.title),
  );
  const visible = candidates.filter((window) => !sharingIndicatorTitles.has(window.title));
  // Helpers belong to the content behind them, which may not be the app's largest window.
  const window = visible.find((candidate, index) => {
    if (candidate.title.trim() !== "") return true;
    const bounds = candidate.bounds;
    return !visible.some((reference, referenceIndex) => {
      if (referenceIndex <= index) return false;
      return (
        (bounds.x === reference.bounds.x &&
          bounds.width === reference.bounds.width &&
          bounds.y <= reference.bounds.y &&
          reference.bounds.y - bounds.y <=
            reference.bounds.height * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.height <= bounds.width * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.height <= reference.bounds.height * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO) ||
        (bounds.y === reference.bounds.y &&
          bounds.height === reference.bounds.height &&
          bounds.x <= reference.bounds.x &&
          reference.bounds.x - bounds.x <=
            reference.bounds.width * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.width <= bounds.height * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO &&
          bounds.width <= reference.bounds.width * MAC_HELPER_STRIP_MAX_THICKNESS_RATIO)
      );
    });
  });
  if (!window) return undefined;
  return {
    platform: "macos",
    id: window.id,
    title: window.title,
    bounds: window.bounds,
    owner: {
      name: lookup.owner.name,
      processId: lookup.owner.processId,
      path: lookup.owner.path,
      ...(lookup.owner.bundleId ? { bundleId: lookup.owner.bundleId } : {}),
    },
  };
}

async function windowsActiveWindow(): Promise<ActiveWindow | undefined> {
  const api = await loadWindowsForegroundApi();
  const handle = api.getForegroundWindow();
  if (handle === 0n) return undefined;
  const bounds = api.getWindowRect(handle);
  if (!bounds) return undefined;
  const { processId } = api.getWindowThreadAndProcessId(handle);
  const path = processId === 0 ? "" : api.getProcessImagePath(processId);
  const name = path.split(/[\\/]/).pop() ?? "";
  return {
    platform: "windows",
    id: Number(handle),
    title: api.getWindowText(handle),
    bounds,
    owner: { name, processId, path },
  };
}

export function activeWindow(platform: NodeJS.Platform): Promise<ActiveWindow | undefined> {
  if (platform === "darwin") return macActiveWindow();
  if (platform === "win32") return windowsActiveWindow();
  return Promise.resolve(undefined);
}
