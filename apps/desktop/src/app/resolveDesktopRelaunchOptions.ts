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

export function buildAppImageRelaunchShellCommand(input: {
  readonly appImagePath: string;
  readonly args: readonly string[];
  readonly delayMs: number;
}): string {
  const sleepSeconds = Math.max(0.2, input.delayMs / 1_000).toFixed(1);
  const quotedPath = posixShellSingleQuote(input.appImagePath);
  const quotedArgs = input.args.map(posixShellSingleQuote).join(" ");
  const execTarget = quotedArgs.length > 0 ? `${quotedPath} ${quotedArgs}` : quotedPath;
  return `sleep ${sleepSeconds} && exec ${execTarget}`;
}
