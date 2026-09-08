// @effect-diagnostics nodeBuiltinImport:off -- This platform boundary asks the OS for its foreground window with Node.

import * as NodeChildProcess from "node:child_process";

import * as Schema from "effect/Schema";

import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";

/**
 * The foreground window as the snapshot service needs it. `id` is the
 * CGWindowNumber on macOS and the HWND on Windows, which is what the capture
 * backends key on.
 */
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

const MacActiveWindow = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  bounds: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  owner: Schema.Struct({
    name: Schema.String,
    processId: Schema.Number,
    path: Schema.String,
    bundleId: Schema.String,
  }),
});
const decodeMacActiveWindow = Schema.decodeUnknownSync(Schema.fromJsonString(MacActiveWindow));

// The frontmost app's first on-screen, layer-0 window in front-to-back order is
// the active window. Window titles need Screen Recording, which the snapshot
// service has already requested by the time this runs.
const MAC_LOOKUP_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (app.isNil()) return "";
  const pid = app.processIdentifier;
  const list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID,
  );
  $.CFMakeCollectable(list);
  const count = $.CFArrayGetCount(list);
  for (let i = 0; i < count; i++) {
    const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
    if (w.objectForKey("kCGWindowOwnerPID").js !== pid) continue;
    if (w.objectForKey("kCGWindowLayer").js !== 0) continue;
    const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    return JSON.stringify({
      id: w.objectForKey("kCGWindowNumber").js,
      title: String(ObjC.unwrap(w.objectForKey("kCGWindowName")) || ""),
      bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height },
      owner: {
        name: String(app.localizedName.js || ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || ""),
        processId: pid,
        path: String(app.bundleURL.path.js || ""),
        bundleId: String(app.bundleIdentifier.js || ""),
      },
    });
  }
  return "";
}`;

function runMacLookup(): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_LOOKUP_SCRIPT],
      { timeout: MAC_LOOKUP_TIMEOUT_MS, maxBuffer: 64 * 1024 },
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
  const window = decodeMacActiveWindow(output);
  return {
    platform: "macos",
    id: window.id,
    title: window.title,
    bounds: window.bounds,
    owner: {
      name: window.owner.name,
      processId: window.owner.processId,
      path: window.owner.path,
      ...(window.owner.bundleId ? { bundleId: window.owner.bundleId } : {}),
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

/** Resolve the OS foreground window, or `undefined` when there is none. */
export function activeWindow(platform: NodeJS.Platform): Promise<ActiveWindow | undefined> {
  if (platform === "darwin") return macActiveWindow();
  if (platform === "win32") return windowsActiveWindow();
  return Promise.resolve(undefined);
}
