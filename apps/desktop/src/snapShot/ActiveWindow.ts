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
});
const decodeMacActiveWindowLookup = Schema.decodeUnknownSync(
  Schema.fromJsonString(MacActiveWindowLookup),
);

const MAC_LOOKUP_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run() {
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
  return JSON.stringify({
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

async function macActiveWindow(): Promise<ActiveWindow | undefined> {
  const output = (await runMacLookup()).trim();
  if (!output) return undefined;
  const lookup = decodeMacActiveWindowLookup(output);
  const visible = lookup.windows.filter(
    (window) => window.alpha > 0 && window.bounds.width > 0 && window.bounds.height > 0,
  );
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
