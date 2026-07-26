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
 *
 * Resolves once the helper has actually spawned, and rejects if it could not
 * (ENOENT on /bin/sh, EAGAIN, ...). `spawn` reports those asynchronously, so
 * the caller must await this before exiting — quitting on a failed spawn is an
 * app that never comes back, with nothing logged to say why.
 */
export function scheduleAppImageRelaunch(
  plan: DesktopAppImageRelaunchPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = buildAppImageRelaunchShellCommand(plan);
  return new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", command], {
      detached: true,
      stdio: "ignore",
      env,
      // The current working directory can live inside the AppImage FUSE mount,
      // which is unmounted while this helper sleeps. Anchor the helper (and the
      // relaunched AppImage that inherits its cwd) outside the mount.
      cwd: "/",
    });
    child.once("spawn", () => {
      // Detach from our event loop so the pending sleep cannot hold up exit.
      child.unref();
      resolve();
    });
    child.once("error", (error) => {
      child.unref();
      reject(error);
    });
  });
}
