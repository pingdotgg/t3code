import type { DesktopCliCommandState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// Settings → Install `t3` command, like VS Code's "Install 'code' command".
// The app's launcher (see DesktopCliShim) lives in the T3 home and is off PATH
// by default. Installing links it into a directory on the user's PATH, or on
// Windows adds the launcher's directory to the user's PATH. Removing undoes
// exactly what installing did and never touches a `t3` the app did not create.

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

/** User-writable directories that login shells commonly put on PATH, in preference order. */
const unixCandidates = (home: string, platform: NodeJS.Platform) =>
  platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`]
    : [`${home}/.local/bin`, `${home}/bin`];

const pathEntries = (value: string | undefined, separator: string) =>
  (value ?? "").split(separator).filter((entry) => entry.length > 0);

/** Windows paths compare without case or a trailing separator. */
const sameWindowsPath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();

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

  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const linkTarget = (link: string) =>
    fs.readLink(link).pipe(
      Effect.map((target) => path.resolve(path.dirname(link), target)),
      Effect.option,
    );
  const isOurLink = (link: string) =>
    linkTarget(link).pipe(Effect.map((target) => Option.getOrUndefined(target) === launcher));
  const writableDirectory = (directory: string) =>
    fs.access(directory, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /** `reg.exe` with output captured; registry edits need no extra dependency. */
  const reg = (args: ReadonlyArray<string>) =>
    spawner
      .string(ChildProcess.make("reg", args, { stdin: "ignore", stderr: "ignore" }))
      .pipe(Effect.mapError(() => fail("Could not read your PATH from the registry.")));
  const readUserPath = reg(["query", "HKCU\\Environment", "/v", "Path"]).pipe(
    Effect.map((output) => {
      const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
      return match?.[1]?.trim() ?? "";
    }),
    // A user without a PATH value of their own has an empty one.
    Effect.orElseSucceed(() => ""),
  );
  const writeUserPath = (value: string) =>
    spawner
      .exitCode(
        ChildProcess.make(
          "reg",
          ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", value, "/f"],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.mapError(() => fail("Could not update your PATH in the registry.")),
        Effect.flatMap((code) =>
          code === 0
            ? Effect.void
            : Effect.fail(fail("Could not update your PATH in the registry.")),
        ),
      );

  /** Where this app's command is installed now, if anywhere. */
  const installedAt = Effect.gen(function* () {
    if (windows) {
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
    const onPath = Option.match(installed, {
      onNone: () => false,
      onSome: (installedPath) =>
        windows || pathEntries(process.env.PATH, ":").includes(path.dirname(installedPath)),
    });
    return { supported: true, installedPath: Option.getOrNull(installed), onPath };
  }).pipe(Effect.orElseSucceed(() => ({ supported: false, installedPath: null, onPath: false })));

  const install: DesktopCliCommand["Service"]["install"] = Effect.gen(function* () {
    if (!environment.isPackaged) return yield* fail("The t3 command needs an installed app.");
    if (!(yield* exists(launcher))) {
      return yield* fail(
        "The app has not set up its t3 launcher yet. Restart T3 Code and try again.",
      );
    }
    if (windows) {
      const current = yield* readUserPath;
      const entries = pathEntries(current, ";");
      if (!entries.some((entry) => sameWindowsPath(entry, binDirectory))) {
        yield* writeUserPath([...entries, binDirectory].join(";"));
      }
      return yield* state;
    }
    if (Option.isSome(yield* installedAt)) return yield* state;
    const onPath = pathEntries(process.env.PATH, ":");
    const candidates = unixCandidates(environment.homeDirectory, environment.platform);
    // Prefer a directory already on PATH that the user can write to without admin rights.
    for (const directory of [
      ...candidates.filter((candidate) => onPath.includes(candidate)),
      ...candidates.filter((candidate) => !onPath.includes(candidate)),
    ]) {
      const link = path.join(directory, "t3");
      if (yield* exists(link)) continue;
      const created = (yield* exists(directory))
        ? yield* writableDirectory(directory)
        : yield* fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (!created) continue;
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
      const current = yield* readUserPath;
      const entries = pathEntries(current, ";");
      const kept = entries.filter((entry) => !sameWindowsPath(entry, binDirectory));
      if (kept.length !== entries.length) yield* writeUserPath(kept.join(";"));
      return yield* state;
    }
    const installed = yield* installedAt;
    if (Option.isSome(installed)) {
      yield* fs
        .remove(installed.value)
        .pipe(Effect.mapError(() => fail(`Could not remove ${installed.value}.`)));
    }
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.uninstall"));

  return DesktopCliCommand.of({ state, install, uninstall });
});

export const layer = Layer.effect(DesktopCliCommand, make);
