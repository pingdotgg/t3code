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
 * Only emitted for bash. Chromium's fds are well above 9, and dash — `/bin/sh`
 * on Debian and Ubuntu — does not accept multi-digit fd numbers in
 * redirections: it reads `exec 10>&-` as running a command named `10`, and a
 * failed `exec` terminates a non-interactive shell on the spot. That kills the
 * helper before it reaches the re-exec, leaving the app gone for good. `eval`
 * does not help, because this is a failed command rather than a parse error,
 * so `|| true` never runs.
 */
const CLOSE_INHERITED_FDS_SNIPPET =
  'for fd in /proc/$$/fd/*; do n=${fd##*/}; case "$n" in 0|1|2) continue;; esac; ' +
  'eval "exec $n>&-" 2>/dev/null || true; done';

export function buildAppImageRelaunchShellCommand(input: {
  readonly appImagePath: string;
  readonly args: readonly string[];
  readonly delayMs: number;
  /** Only safe under bash; see {@link CLOSE_INHERITED_FDS_SNIPPET}. */
  readonly closeInheritedFds?: boolean;
  /** Captures the helper's stderr, so a failed delayed `exec` is diagnosable. */
  readonly logPath?: string | undefined;
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
  // The exec happens after we have exited, so a missing or non-executable
  // AppImage can only be reported by leaving a trace behind. Test for it and
  // append a line *after* the exec instead of redirecting the whole group:
  //
  //   - `{ ...; } 2>>log` fails the redirection outright when the log's
  //     directory is missing or unwritable, and the re-exec then never runs at
  //     all — trading a diagnosable failure for a guaranteed one.
  //   - that redirection also survives a *successful* exec, so the relaunched
  //     app would spend its whole life appending Chromium stderr to an
  //     unrotated file.
  //
  // `2>/dev/null` on the append keeps a bad log path from mattering, and the
  // exec'd process keeps the stdio it was always meant to have.
  const relaunch = input.logPath
    ? `sleep ${sleepSeconds}; [ -x ${quotedPath} ] && exec ${execTarget}; ` +
      `echo ${posixShellSingleQuote(`T3 Code relaunch failed: ${input.appImagePath} is missing or not executable`)} ` +
      `>>${posixShellSingleQuote(input.logPath)} 2>/dev/null`
    : `sleep ${sleepSeconds} && exec ${execTarget}`;
  // Close first, then sleep: releasing the fds up front lets the outgoing
  // mount unmount *during* the delay rather than after it.
  return input.closeInheritedFds ? `${CLOSE_INHERITED_FDS_SNIPPET}; ${relaunch}` : relaunch;
}
