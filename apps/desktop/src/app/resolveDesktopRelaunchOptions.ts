export interface DesktopRelaunchOptions {
  readonly execPath: string;
  readonly args: string[];
}

/**
 * Resolve Electron relaunch options for the current packaging mode.
 *
 * AppImage mounts the payload under a temporary directory and sets `APPIMAGE`
 * to the outer `.AppImage` path. `process.execPath` / `process.argv` point at
 * the mount, which is unmounted when the process exits — so relaunching with
 * those paths exits and never comes back. Prefer `$APPIMAGE`.
 *
 * Keep only flag-style argv entries (e.g. `--no-sandbox` from Gear Lever /
 * Flatpak launches). Mount-local positional paths must not be reused.
 */
export function resolveDesktopRelaunchOptions(input: {
  readonly appImagePath?: string | null | undefined;
  readonly execPath: string;
  readonly argv: readonly string[];
}): DesktopRelaunchOptions {
  const appImagePath = input.appImagePath?.trim();
  if (appImagePath) {
    return {
      execPath: appImagePath,
      args: input.argv.slice(1).filter((arg) => arg.startsWith("--")),
    };
  }

  return {
    execPath: input.execPath,
    args: input.argv.slice(1),
  };
}
