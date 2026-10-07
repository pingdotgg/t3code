import type { DesktopCliCommandState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// Settings → Install `t3` command, like VS Code's "Install 'code' command".
// The app's launcher (see DesktopCliShim) lives in the T3 home and is off PATH
// by default. Installing links it into a folder on the user's PATH, or on
// Windows adds the launcher's folder to the user's PATH. Removing undoes only
// what installing did: a link that points at one of the app's launchers, or a
// PATH entry the app recorded adding.

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

/** User-writable folders that login shells commonly put on PATH, in preference order. */
const unixCandidates = (home: string, platform: NodeJS.Platform) =>
  platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`]
    : [`${home}/.local/bin`, `${home}/bin`];

const pathEntries = (value: string | undefined, separator: string) =>
  (value ?? "").split(separator).filter((entry) => entry.length > 0);

/** Windows paths compare without case or a trailing separator. */
const sameWindowsPath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();

/**
 * Reads, or with `T3_SET` set writes, the user's PATH. .NET keeps the value's
 * registry type and unexpanded `%VAR%` entries, and broadcasts the change so
 * Explorer and terminals it opens see it. A failed read exits nonzero rather
 * than reading as empty, so a write never replaces the user's PATH wholesale.
 */
const WINDOWS_USER_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($env:T3_SET -eq '1') {
  [Environment]::SetEnvironmentVariable('Path', $env:T3_PATH, 'User')
} else {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $value = if ($key) { $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))
}
`;

export class DesktopCliCommand extends Context.Service<
  DesktopCliCommand,
  {
    readonly state: Effect.Effect<DesktopCliCommandState>;
    readonly install: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    readonly uninstall: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
  }
>()("@t3tools/desktop/app/DesktopCliCommand") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const launcher = DesktopCliShim.launcherPath(environment);
  const binDirectory = path.dirname(launcher);
  /** Records that Install added `binDirectory` to the Windows PATH, so Remove takes out only that. */
  const ownedPathMarker = path.join(environment.stateDir, "cli-command-path-entry");

  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const writableDirectory = (directory: string) =>
    fs.access(directory, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /**
   * A link to one of the app's launchers, by the marker the launcher carries.
   * This also finds links made under a previous T3 home, so Remove can clean
   * them up and Install does not add a second.
   */
  const isOurLink = (link: string) =>
    Effect.gen(function* () {
      yield* fs.readLink(link);
      const content = yield* fs.readFileString(link);
      return content.includes(DesktopCliShim.MARKER);
    }).pipe(Effect.orElseSucceed(() => false));

  const powershell = (env: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = process.env.SystemRoot ?? process.env.WINDIR;
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_PATH_SCRIPT],
            { stdin: "ignore", stderr: "ignore", env, extendEnv: true },
          ),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) return yield* Effect.fail(`powershell exited with ${exitCode}`);
        return stdout;
      }),
    );
  const readUserPath = powershell({}).pipe(
    Effect.map((encoded) => Buffer.from(encoded.trim(), "base64").toString("utf8")),
    Effect.mapError(() => fail("Could not read your PATH, so it was left unchanged.")),
  );
  const writeUserPath = (value: string) =>
    powershell({ T3_SET: "1", T3_PATH: value }).pipe(
      Effect.asVoid,
      Effect.mapError(() => fail("Could not update your PATH.")),
    );

  /** The `t3` a new shell runs, by PATH order, or none. */
  const firstOnPath = Effect.gen(function* () {
    for (const directory of pathEntries(process.env.PATH, ":")) {
      const candidate = path.join(directory, "t3");
      if (yield* exists(candidate)) return Option.some(candidate);
    }
    return Option.none<string>();
  });

  /** Where this app's command is installed now, if anywhere. */
  const installedAt = Effect.gen(function* () {
    if (windows) {
      if (!(yield* exists(ownedPathMarker))) return Option.none<string>();
      const entries = pathEntries(yield* readUserPath, ";");
      return entries.some((entry) => sameWindowsPath(entry, binDirectory))
        ? Option.some(launcher)
        : Option.none<string>();
    }
    for (const directory of unixCandidates(environment.homeDirectory, environment.platform)) {
      const link = path.join(directory, "t3");
      if (yield* isOurLink(link)) return Option.some(link);
    }
    return Option.none<string>();
  });

  const state: DesktopCliCommand["Service"]["state"] = Effect.gen(function* () {
    if (!environment.isPackaged) {
      return { supported: false, installedPath: null, onPath: false } as const;
    }
    const installed = yield* installedAt;
    if (Option.isNone(installed)) return { supported: true, installedPath: null, onPath: false };
    // On Windows only terminals opened after the change see it. On Unix the
    // first `t3` on PATH must be ours; a `t3` earlier on PATH would shadow it.
    const first = yield* firstOnPath;
    const onPath = windows || (Option.isSome(first) && (yield* isOurLink(first.value)));
    return { supported: true, installedPath: installed.value, onPath };
  }).pipe(Effect.orElseSucceed(() => ({ supported: false, installedPath: null, onPath: false })));

  /** Writes the launcher if the app has not yet, e.g. when no local backend runs. */
  const ensureLauncher = DesktopCliShim.install.pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(fail(`Could not set up the t3 launcher at ${launcher}.`)),
        onSome: () => Effect.void,
      }),
    ),
  );

  const install: DesktopCliCommand["Service"]["install"] = Effect.gen(function* () {
    if (!environment.isPackaged) return yield* fail("The t3 command needs an installed app.");
    yield* ensureLauncher;
    if (windows) {
      const entries = pathEntries(yield* readUserPath, ";");
      if (!entries.some((entry) => sameWindowsPath(entry, binDirectory))) {
        yield* writeUserPath([...entries, binDirectory].join(";"));
        yield* fs
          .writeFileString(ownedPathMarker, `${binDirectory}\n`)
          .pipe(Effect.mapError(() => fail("Added t3 to your PATH but could not record it.")));
      }
      return yield* state;
    }
    if (Option.isSome(yield* installedAt)) return yield* state;
    const onPath = pathEntries(process.env.PATH, ":");
    const candidates = unixCandidates(environment.homeDirectory, environment.platform);
    // Prefer a folder already on PATH that the user can write to without admin rights.
    for (const directory of [
      ...candidates.filter((candidate) => onPath.includes(candidate)),
      ...candidates.filter((candidate) => !onPath.includes(candidate)),
    ]) {
      const link = path.join(directory, "t3");
      const created = (yield* exists(directory))
        ? yield* writableDirectory(directory)
        : yield* fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (!created) continue;
      // symlink fails if anything, even a broken link, is already there.
      const linked = yield* fs.symlink(launcher, link).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) return yield* state;
    }
    return yield* fail(
      `Another t3 command is already installed, or no folder on your PATH is writable. Run the launcher directly at ${launcher}.`,
    );
  }).pipe(Effect.withSpan("desktop.cliCommand.install"));

  const uninstall: DesktopCliCommand["Service"]["uninstall"] = Effect.gen(function* () {
    if (windows) {
      if (yield* exists(ownedPathMarker)) {
        const entries = pathEntries(yield* readUserPath, ";");
        const kept = entries.filter((entry) => !sameWindowsPath(entry, binDirectory));
        if (kept.length !== entries.length) yield* writeUserPath(kept.join(";"));
        yield* fs.remove(ownedPathMarker).pipe(Effect.ignore);
      }
      return yield* state;
    }
    for (const directory of unixCandidates(environment.homeDirectory, environment.platform)) {
      const link = path.join(directory, "t3");
      if (yield* isOurLink(link)) {
        yield* fs.remove(link).pipe(Effect.mapError(() => fail(`Could not remove ${link}.`)));
      }
    }
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.uninstall"));

  return DesktopCliCommand.of({ state, install, uninstall });
});

export const layer = Layer.effect(DesktopCliCommand, make);
