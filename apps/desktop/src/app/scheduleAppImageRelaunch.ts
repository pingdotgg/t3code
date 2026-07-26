// @effect-diagnostics nodeBuiltinImport:off - Detached AppImage re-exec must outlive the Effect runtime and process exit path; Effect ChildProcess is scope-bound.
import * as NodeChildProcess from "node:child_process";

import {
  buildAppImageRelaunchShellCommand,
  type DesktopAppImageRelaunchPlan,
} from "./resolveDesktopRelaunchOptions.ts";

/**
 * Schedule a delayed re-exec of the outer AppImage after this process exits.
 *
 * Electron.app.relaunch races the AppImage FUSE unmount and often fails with
 * "Cannot mount AppImage, please check your FUSE setup." A short sleep lets
 * the current mount clean up before the next runtime attaches.
 */
export function scheduleAppImageRelaunch(
  plan: DesktopAppImageRelaunchPlan,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const command = buildAppImageRelaunchShellCommand(plan);
  const child = NodeChildProcess.spawn("/bin/sh", ["-c", command], {
    detached: true,
    stdio: "ignore",
    env,
    // The current working directory can live inside the AppImage FUSE mount,
    // which is unmounted while this helper sleeps. Anchor the helper (and the
    // relaunched AppImage that inherits its cwd) outside the mount.
    cwd: "/",
  });
  child.unref();
}
