/**
 * Best-effort activate-or-launch of the installed T3 Code desktop app so
 * `t3 .` can attach a project to it instead of starting a headless server.
 */
import * as NodePath from "node:path";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/** Bundle / window names electron-builder ships for stable and nightly. */
export const DESKTOP_APP_NAMES = ["T3 Code (Alpha)", "T3 Code (Nightly)", "T3 Code"] as const;

const FIXED_LINUX_DESKTOP_ENTRY_IDS = ["com.t3tools.t3code", "t3-code", "t3code"] as const;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

const WAIT_IGNORE_STDIO_OPTIONS = {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

export function windowsDesktopExecutableCandidates(localAppData: string): ReadonlyArray<string> {
  const programs = NodePath.join(localAppData, "Programs");
  const out: Array<string> = [];
  for (const name of DESKTOP_APP_NAMES) {
    out.push(NodePath.join(programs, "t3-code", `${name}.exe`));
    out.push(NodePath.join(programs, name, `${name}.exe`));
  }
  return out;
}

/** True when a FreeDesktop entry looks like an installed T3 Code desktop app. */
export function isT3LinuxDesktopEntry(contents: string): boolean {
  return (
    /(?:^|\n)\s*Name\s*=\s*T3 Code(?:\s|\(|$)/im.test(contents) ||
    /com\.t3tools\.t3code/i.test(contents) ||
    /(?:^|\n)\s*Exec\s*=.*(?:[Tt]3[ -]?[Cc]ode|t3-code|t3code)/m.test(contents)
  );
}

/**
 * Map `.desktop` filenames + contents to `gtk-launch` ids, including AppImage
 * installs that mint `appimagekit_<hash>-....desktop` names.
 */
export function linuxDesktopEntryLaunchIds(
  entries: ReadonlyArray<{ readonly fileName: string; readonly contents: string }>,
): ReadonlyArray<string> {
  const ids: Array<string> = [];
  for (const entry of entries) {
    if (!entry.fileName.toLowerCase().endsWith(".desktop")) continue;
    if (!isT3LinuxDesktopEntry(entry.contents)) continue;
    ids.push(entry.fileName.replace(/\.desktop$/i, ""));
  }
  return ids;
}

/** True when the command exits with status 0 (used for `open` / `gtk-launch`). */
const spawnExitOk = Effect.fn("desktopLaunch.spawnExitOk")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(ChildProcess.make(command, [...args], WAIT_IGNORE_STDIO_OPTIONS))
    .pipe(
      Effect.map((code) => code === 0),
      Effect.catch(() => Effect.succeed(false)),
    );
});

/** True only after the child has actually spawned; false on launch errors. */
const spawnDetachedOk = Effect.fn("desktopLaunch.spawnDetachedOk")(function* (
  command: string,
  args: ReadonlyArray<string> = [],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .spawn(ChildProcess.make(command, [...args], DETACHED_IGNORE_STDIO_OPTIONS))
    .pipe(
      Effect.flatMap((handle) => handle.unref.pipe(Effect.as(true))),
      Effect.scoped,
      Effect.catch(() => Effect.succeed(false)),
    );
});

const resolveWindowsLocalAppData = Effect.fn("desktopLaunch.resolveWindowsLocalAppData")(
  function* () {
    const env = yield* HostProcessEnvironment;
    const path = yield* Path.Path;
    const fromEnv = env.LOCALAPPDATA?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) {
      return path.join(userProfile, "AppData", "Local");
    }
    return undefined;
  },
);

const discoverLinuxDesktopEntryIds = Effect.fn("desktopLaunch.discoverLinuxDesktopEntryIds")(
  function* () {
    const env = yield* HostProcessEnvironment;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const home = env.HOME?.trim();
    const dirs = [
      ...(home ? [path.join(home, ".local", "share", "applications")] : []),
      "/usr/share/applications",
      "/usr/local/share/applications",
    ];

    const entries: Array<{ readonly fileName: string; readonly contents: string }> = [];
    for (const dir of dirs) {
      const fileNames = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])));
      for (const fileName of fileNames) {
        if (!fileName.toLowerCase().endsWith(".desktop")) continue;
        const contents = yield* fs
          .readFileString(path.join(dir, fileName))
          .pipe(Effect.catch(() => Effect.succeed("")));
        if (contents.length === 0) continue;
        entries.push({ fileName, contents });
      }
    }
    return linuxDesktopEntryLaunchIds(entries);
  },
);

/** Activate a running desktop app, or launch it if installed. */
export const tryLaunchDesktopApp = Effect.fn("tryLaunchDesktopApp")(function* () {
  const platform = yield* HostProcessPlatform;

  if (platform === "darwin") {
    for (const name of DESKTOP_APP_NAMES) {
      if (yield* spawnExitOk("open", ["-a", name])) {
        return true;
      }
    }
    return false;
  }

  if (platform === "win32") {
    const fs = yield* FileSystem.FileSystem;
    const localAppData = yield* resolveWindowsLocalAppData();
    if (localAppData === undefined) {
      return false;
    }
    for (const exe of windowsDesktopExecutableCandidates(localAppData)) {
      if (!(yield* fs.exists(exe))) continue;
      if (yield* spawnDetachedOk(exe)) {
        return true;
      }
    }
    return false;
  }

  // Linux: try known desktop-file ids, then scan applications dirs for AppImage
  // installs that mint `appimagekit_<hash>-….desktop` names.
  const launchIds = new Set<string>([
    ...FIXED_LINUX_DESKTOP_ENTRY_IDS,
    ...(yield* discoverLinuxDesktopEntryIds()),
  ]);
  for (const id of launchIds) {
    if (yield* spawnExitOk("gtk-launch", [id])) {
      return true;
    }
  }
  return false;
});
