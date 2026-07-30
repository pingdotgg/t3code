// @effect-diagnostics nodeBuiltinImport:off - Detached AppImage re-exec must outlive the Effect runtime and process exit path; Effect ChildProcess is scope-bound.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

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
 * (ENOENT on the shell, EAGAIN, ...). `spawn` reports those asynchronously, so
 * the caller must await this before exiting — quitting on a failed spawn is an
 * app that never comes back, with nothing logged to say why.
 *
 * Note this cannot vouch for the delayed `exec` itself: if the AppImage is
 * moved or loses its execute bit during the sleep, that failure happens after
 * we are gone. The helper's stderr is redirected to a log for that case.
 */
const BASH_PATH = "/bin/bash";

/**
 * Prefer bash for the helper, falling back to `/bin/sh`.
 *
 * Only bash can close the inherited Chromium fds that otherwise pin the
 * outgoing FUSE mount — dash (Debian/Ubuntu `/bin/sh`) rejects fd numbers above
 * 9 and would abort the helper mid-script. Every distribution that ships
 * AppImages ships bash, so the `/bin/sh` fallback is a belt-and-braces path
 * that relaunches correctly but leaves the old mount behind.
 */
function resolveRelaunchShell(): { readonly path: string; readonly isBash: boolean } {
  try {
    NodeFS.accessSync(BASH_PATH, NodeFS.constants.X_OK);
    return { path: BASH_PATH, isBash: true };
  } catch {
    return { path: "/bin/sh", isBash: false };
  }
}

export function scheduleAppImageRelaunch(
  plan: DesktopAppImageRelaunchPlan,
  env: NodeJS.ProcessEnv = process.env,
  logPath?: string,
): Promise<void> {
  const shell = resolveRelaunchShell();
  const command = buildAppImageRelaunchShellCommand({
    ...plan,
    closeInheritedFds: shell.isBash,
    ...(logPath === undefined ? {} : { logPath }),
  });
  return new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(shell.path, ["-c", command], {
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
