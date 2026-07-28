export interface DesktopElectronRelaunchPlan {
  readonly kind: "electron";
  readonly execPath: string;
  readonly args: string[];
}

export interface DesktopAppImageRelaunchPlan {
  readonly kind: "appimage-delayed";
  readonly appImagePath: string;
  readonly args: string[];
  /** Delay before re-exec so the current AppImage can unmount its FUSE image. */
  readonly delayMs: number;
}

export type DesktopRelaunchPlan = DesktopElectronRelaunchPlan | DesktopAppImageRelaunchPlan;

export const DEFAULT_APPIMAGE_RELAUNCH_DELAY_MS = 1_000;

/**
 * Resolve how the desktop process should restart for the current packaging mode.
 *
 * AppImage mounts the payload under a temporary directory and sets `APPIMAGE`
 * to the outer `.AppImage` path. `process.execPath` / `process.argv` point at
 * the mount, which is unmounted when the process exits — so relaunching with
 * those paths (or racing a second FUSE mount while the first unmounts) fails
 * with "Cannot mount AppImage, please check your FUSE setup."
 *
 * For AppImage we schedule a delayed re-exec of `$APPIMAGE` after the current
 * process exits. Keep only flag-style argv entries (e.g. `--no-sandbox` from
 * Gear Lever / Flatpak launches).
 */
export function resolveDesktopRelaunchPlan(input: {
  readonly appImagePath?: string | null | undefined;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly appImageDelayMs?: number;
}): DesktopRelaunchPlan {
  const appImagePath = input.appImagePath?.trim();
  if (appImagePath) {
    return {
      kind: "appimage-delayed",
      appImagePath,
      args: input.argv.slice(1).filter((arg) => arg.startsWith("--")),
      delayMs: input.appImageDelayMs ?? DEFAULT_APPIMAGE_RELAUNCH_DELAY_MS,
    };
  }

  return {
    kind: "electron",
    execPath: input.execPath,
    args: input.argv.slice(1),
  };
}

/** POSIX-safe single-quoting for `/bin/sh -c` command construction. */
export function posixShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Drop file descriptors inherited from the exiting app before re-exec.
 *
 * Chromium keeps fds open without CLOEXEC (`app.asar`, `icudtl.dat`, the `.pak`
 * files, the mount directory itself), and `spawn` cannot close them for us.
 * Inherited through this helper's `exec`, they keep the *outgoing* AppImage's
 * FUSE mount busy forever: its runtime process parks in `fuse_dev_do_read` and
 * never unmounts, so every restart strands a mount and a process.
 *
 * The multi-digit `exec N>&-` is inside an `eval` string on purpose. Shells
 * differ on whether they accept fd numbers above 9, and a parse error in the
 * script body would mean never reaching the exec at all — an app that quits and
 * never returns. Deferring the parse to `eval` makes the worst case "fds stay
 * open", not "the app is gone".
 */
const CLOSE_INHERITED_FDS_SNIPPET =
  'for fd in /proc/$$/fd/*; do n=${fd##*/}; case "$n" in 0|1|2) continue;; esac; ' +
  'eval "exec $n>&-" 2>/dev/null || true; done';

export function buildAppImageRelaunchShellCommand(input: {
  readonly appImagePath: string;
  readonly args: readonly string[];
  readonly delayMs: number;
}): string {
  // Whole seconds only: POSIX specifies `sleep` as taking an integer, and a
  // /bin/sh whose sleep rejects "1.0" would short-circuit the `&&` and never
  // exec — an app that quits and never returns, which is the failure this
  // helper exists to avoid. The spawn succeeds either way, so nothing would
  // report it.
  const sleepSeconds = Math.max(1, Math.ceil(input.delayMs / 1_000));
  const quotedPath = posixShellSingleQuote(input.appImagePath);
  const quotedArgs = input.args.map(posixShellSingleQuote).join(" ");
  const execTarget = quotedArgs.length > 0 ? `${quotedPath} ${quotedArgs}` : quotedPath;
  // Close first, then sleep: releasing the fds up front lets the outgoing
  // mount unmount *during* the delay rather than after it.
  return `${CLOSE_INHERITED_FDS_SNIPPET}; sleep ${sleepSeconds} && exec ${execTarget}`;
}
