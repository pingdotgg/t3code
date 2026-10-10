// @effect-diagnostics nodeBuiltinImport:off -- This native boundary keeps one JXA process open while the permission helper tracks System Settings.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

const SettingsWindow = Schema.NullOr(
  Schema.Struct({
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
    frontmost: Schema.Boolean,
  }),
);
export type SettingsWindow = typeof SettingsWindow.Type;
const decodeSettingsWindow = Schema.decodeUnknownSync(Schema.fromJsonString(SettingsWindow));

// Window bounds and owner PIDs are available before Screen Recording is granted.
// Use the bundle identifier rather than the localized app/window title. A single
// process avoids launching osascript repeatedly while the user moves Settings.
const SETTINGS_WINDOW_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run() {
  let previous = "";
  while (true) {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.systempreferences");
    let result = null;
    if (apps.count > 0) {
      const pid = apps.objectAtIndex(0).processIdentifier;
      const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      const list = $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
        $.kCGNullWindowID
      );
      if (list) {
        $.CFMakeCollectable(list);
        const count = $.CFArrayGetCount(list);
        for (let i = 0; i < count; i++) {
          const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
          if (w.objectForKey("kCGWindowOwnerPID").js !== pid || w.objectForKey("kCGWindowLayer").js !== 0) continue;
          const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
          if (b.Width < 500 || b.Height < 350) continue;
          result = { x: b.X, y: b.Y, width: b.Width, height: b.Height, frontmost: !front.isNil() && front.processIdentifier === pid };
          break;
        }
      }
    }
    const line = JSON.stringify(result);
    if (line !== previous) {
      const data = $(line + "\\n").dataUsingEncoding($.NSUTF8StringEncoding);
      $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
      previous = line;
    }
    $.NSThread.sleepForTimeInterval(result && result.frontmost ? 0.5 : 1);
  }
}`;

/** Place the panel inside Settings' content column, above its bottom edge. */
export function settingsHelperBounds(settings: NonNullable<SettingsWindow>): Electron.Rectangle {
  const sidebarWidth = 216;
  const inset = 16;
  const width = Math.min(560, settings.width - sidebarWidth - inset * 2);
  return {
    x: Math.round(settings.x + sidebarWidth + (settings.width - sidebarWidth - width) / 2),
    y: Math.round(settings.y + settings.height - 140 - inset),
    width: Math.round(width),
    height: 140,
  };
}

/** Track only metadata; this does not request Accessibility or Screen Recording. */
export function watchMacSettingsWindow(
  onChange: (window: SettingsWindow) => void,
  onUnavailable: () => void,
): () => void {
  const child = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", SETTINGS_WINDOW_SCRIPT],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let pending = "";
  let closed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (closed) return;
      let settings: SettingsWindow;
      try {
        settings = decodeSettingsWindow(line);
      } catch {
        onUnavailable();
        continue;
      }
      onChange(settings);
    }
  });
  const onExit = () => {
    if (!closed) onUnavailable();
  };
  child.on("error", onExit);
  child.on("exit", onExit);
  return () => {
    closed = true;
    child.stdout.removeAllListeners("data");
    child.kill();
  };
}
