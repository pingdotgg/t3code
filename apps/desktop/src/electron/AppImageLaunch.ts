// @effect-diagnostics nodeBuiltinImport:off - the pre-ready X11 fallback launches the AppImage synchronously before any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Electron holds the AppImage runtime's keepalive pipe and some files without O_CLOEXEC; a
// relaunched AppImage inherits them, so old runtimes and FUSE mounts never exit. bash (AppRun
// already needs it; dash cannot close multi-digit fds) closes them before exec'ing the AppImage.
// -p skips BASH_ENV and exported functions in the helper only; the AppImage still receives both.
const CLOSE_INHERITED_FDS_THEN_EXEC =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done; exec "$@"';

export const withoutInheritedDescriptors = (
  command: string,
  args: ReadonlyArray<string>,
): readonly [string, Array<string>] => [
  "bash",
  ["-p", "-c", CLOSE_INHERITED_FDS_THEN_EXEC, command, command, ...args],
];

/**
 * Starts a new instance of the AppImage outside this process's FUSE mount. Electron's
 * app.relaunch helper cannot remount it, so fusermount fails there. False when nothing started.
 */
export function launchDetachedAppImage(appImagePath: string, args: ReadonlyArray<string>): boolean {
  if (!NodePath.isAbsolute(appImagePath) || appImagePath.includes("\0")) return false;
  try {
    NodeFS.accessSync(appImagePath, NodeFS.constants.X_OK);
    const [command, commandArgs] = withoutInheritedDescriptors(appImagePath, args);
    const child = NodeChildProcess.spawn(command, commandArgs, { detached: true, stdio: "ignore" });
    // A failed spawn reports through this event after returning without a pid.
    child.on("error", () => undefined);
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}
