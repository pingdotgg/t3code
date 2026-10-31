// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.access has no execute check.
import * as NodeFSP from "node:fs/promises";

import type { DesktopCliCommandState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { replaceOwnedLink } from "@t3tools/shared/ownedLink";
import { pathSetup, readUserLoginShell } from "@t3tools/shared/shell";

import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-cli-command");

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}

const userCandidates = (home: string) => [`${home}/.local/bin`, `${home}/bin`];

// Older builds also linked into these macOS folders. Such a link is found, updated in place, and
// removed, but no new link goes there.
const knownLocations = (home: string, platform: NodeJS.Platform) =>
  platform === "darwin"
    ? [...userCandidates(home), "/opt/homebrew/bin", "/usr/local/bin"]
    : userCandidates(home);

const pathEntries = (value: string | undefined, separator: string) =>
  (value ?? "").split(separator).filter((entry) => entry.length > 0);

const sameWindowsPath = (left: string, right: string) =>
  left.replace(/[\\/]+$/, "").toLowerCase() === right.replace(/[\\/]+$/, "").toLowerCase();

// Preserve REG_EXPAND_SZ and %VAR% expansion; notify Explorer with WM_SETTINGCHANGE.
// Failed reads must exit nonzero to prevent replacing PATH wholesale.
const WINDOWS_USER_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($env:T3_SET -eq '1') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path' -and $key.GetValueKind('Path') -eq 'String') {
    $kind = [Microsoft.Win32.RegistryValueKind]::String
  }
  $key.SetValue('Path', $env:T3_PATH, $kind)
  Add-Type -Namespace T3 -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $result = [System.UIntPtr]::Zero
  [void][T3.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
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
    /** Adds the installed command's folder to PATH in the user's shell startup file. */
    readonly addToPath: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    /** Installs the command on an app's first launch; removing it in Settings sticks. */
    readonly installOnFirstLaunch: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopCliCommand") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const launcher = DesktopCliShim.launcherPath(environment);
  const binDirectory = path.dirname(launcher);
  const ownedPathMarker = path.join(environment.stateDir, "cli-command-path-entry");
  const firstLaunchMarker = path.join(environment.stateDir, "cli-command-first-launch");

  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const writableDirectory = (directory: string) =>
    fs.access(directory, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const isOurLink = Effect.fn("DesktopCliCommand.isOurLink")(
    function* (link: string) {
      // Only a direct link: a chain through another tool's link is that tool's.
      const target = path.resolve(path.dirname(link), yield* fs.readLink(link));
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return false;
      // The launcher is a few KB; never read a large binary another `t3` links to.
      const info = yield* fs.stat(target);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      const content = yield* fs.readFileString(target);
      return content.includes(DesktopCliShim.MARKER);
    },
    Effect.orElseSucceed(() => false),
  );

  /** Other programs write these folders too, so the link is checked again once moved aside. */
  const replaceOurLink = (input: { readonly link: string; readonly target?: string }) =>
    replaceOwnedLink({ ...input, owns: isOurLink }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  // PATH can reach the regular launcher directly; removal still requires isOurLink.
  const runsOurLauncher = Effect.fn("DesktopCliCommand.runsOurLauncher")(
    // Another T3 home's link is marked too, so compare where it leads, not the marker alone.
    function* (candidate: string) {
      const [resolved, ours] = yield* Effect.all([fs.realPath(candidate), fs.realPath(launcher)]);
      if (resolved !== ours) return false;
      const info = yield* fs.stat(candidate);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      return (yield* fs.readFileString(candidate)).includes(DesktopCliShim.MARKER);
    },
    Effect.orElseSucceed(() => false),
  );

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
  // Explicit, so an inherited T3_SET=1 can never turn a read into a PATH write.
  const readUserPath = powershell({ T3_SET: "0" }).pipe(
    Effect.map((encoded) => Buffer.from(encoded.trim(), "base64").toString("utf8")),
    Effect.mapError(() => fail("Could not read your PATH, so it was left unchanged.")),
  );
  const writeUserPath = (value: string) =>
    powershell({ T3_SET: "1", T3_PATH: value }).pipe(
      Effect.asVoid,
      Effect.mapError(() => fail("Could not update your PATH.")),
    );

  const isExecutableFile = Effect.fn("DesktopCliCommand.isExecutableFile")(
    function* (target: string) {
      if ((yield* fs.stat(target)).type !== "File") return false;
      yield* Effect.tryPromise(() => NodeFSP.access(target, NodeFSP.constants.X_OK));
      return true;
    },
    Effect.orElseSucceed(() => false),
  );

  const firstOnPath = Effect.gen(function* () {
    for (const directory of pathEntries(process.env.PATH, ":")) {
      const candidate = path.join(directory, "t3");
      if (yield* isExecutableFile(candidate)) return Option.some(candidate);
    }
    return Option.none<string>();
  });

  const foreignFirstOnPath = Effect.gen(function* () {
    if (windows) return Option.none<string>();
    const first = yield* firstOnPath;
    if (Option.isNone(first) || (yield* runsOurLauncher(first.value))) return Option.none<string>();
    return first;
  });

  /** A link to this home's launcher; another home's link is marked too. */
  const leadsHere = (link: string) =>
    fs.readLink(link).pipe(
      Effect.map((target) => target === launcher),
      Effect.orElseSucceed(() => false),
    );

  const installedAt = Effect.gen(function* () {
    if (windows) {
      if (!(yield* exists(ownedPathMarker))) return Option.none<string>();
      const entries = pathEntries(yield* readUserPath, ";");
      return entries.some((entry) => sameWindowsPath(entry, binDirectory))
        ? Option.some(launcher)
        : Option.none<string>();
    }
    for (const directory of knownLocations(environment.homeDirectory, environment.platform)) {
      const link = path.join(directory, "t3");
      if (yield* isOurLink(link)) return Option.some(link);
    }
    return Option.none<string>();
  });

  const startupLine = (installedPath: string) => {
    const setup = pathSetup({
      directory: path.dirname(installedPath),
      home: environment.homeDirectory,
      // A Finder or desktop launch may not set SHELL.
      shell: process.env.SHELL || readUserLoginShell(),
      platform: environment.platform,
      configHome: process.env.XDG_CONFIG_HOME,
      zdotdir: process.env.ZDOTDIR,
    });
    if (setup === undefined) return undefined;
    const file = setup.file.startsWith("~/")
      ? path.join(environment.homeDirectory, setup.file.slice(2))
      : setup.file;
    return { ...setup, path: file };
  };
  const hasLine = (setup: { readonly path: string; readonly line: string }) =>
    fs.readFileString(setup.path).pipe(
      Effect.map((content) => content.split("\n").some((line) => line.trim() === setup.line)),
      Effect.orElseSucceed(() => false),
    );

  const folderOnPath = (link: string) =>
    Effect.sync(() =>
      pathEntries(process.env.PATH, ":").some(
        (entry) => entry.replace(/\/+$/, "") === path.dirname(link),
      ),
    );

  const state: DesktopCliCommand["Service"]["state"] = Effect.gen(function* () {
    if (!environment.isPackaged) {
      return { supported: false, installedPath: null, onPath: false, launcherPath: null } as const;
    }
    const launcherPath = (yield* exists(launcher)) ? launcher : null;
    const installed = yield* installedAt;
    const shadowedBy = yield* foreignFirstOnPath;
    const shadow = Option.isSome(shadowedBy) ? { shadowedBy: shadowedBy.value } : {};
    const first = yield* firstOnPath;
    const onPath = windows
      ? Option.isSome(installed)
      : Option.isSome(first) && (yield* runsOurLauncher(first.value));
    // Only a folder missing from PATH, with no other t3 first: with one, the added folder (last
    // on PATH) would still not run this t3.
    const setup =
      onPath ||
      Option.isSome(shadowedBy) ||
      Option.isNone(installed) ||
      !(yield* leadsHere(installed.value)) ||
      (yield* folderOnPath(installed.value))
        ? undefined
        : startupLine(installed.value);
    return {
      supported: true,
      installedPath: Option.getOrNull(installed),
      onPath,
      launcherPath,
      ...shadow,
      ...(setup === undefined
        ? {}
        : { pathSetup: { file: setup.file, added: yield* hasLine(setup) } }),
    };
  }).pipe(
    Effect.orElseSucceed(() => ({
      supported: false,
      installedPath: null,
      onPath: false,
      launcherPath: null,
    })),
  );

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
      // PATH would split the folder at the `;`, leaving two wrong entries behind.
      if (binDirectory.includes(";")) {
        return yield* fail(
          `T3 Code cannot put ${binDirectory} on PATH because it has a ";". Run ${launcher} directly.`,
        );
      }
      const entries = pathEntries(yield* readUserPath, ";");
      if (!entries.some((entry) => sameWindowsPath(entry, binDirectory))) {
        yield* writeUserPath([...entries, binDirectory].join(";"));
        yield* fs
          .writeFileString(ownedPathMarker, `${binDirectory}\n`)
          .pipe(Effect.mapError(() => fail("Added t3 to your PATH but could not record it.")));
      }
      return yield* state;
    }
    const candidates = userCandidates(environment.homeDirectory);
    const replaced = Option.getOrUndefined(yield* installedAt);
    if (replaced !== undefined) {
      const target = yield* fs.readLink(replaced).pipe(Effect.option);
      if (Option.getOrUndefined(target) === launcher) return yield* state;
    }
    const shadowedBy = yield* foreignFirstOnPath;
    if (Option.isSome(shadowedBy)) {
      return yield* fail(
        `Another t3 at ${shadowedBy.value} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`,
      );
    }
    // An old link of ours is updated where it is, so a t3 that works now keeps working. It is
    // removed only once a new link exists elsewhere.
    const onPath = pathEntries(process.env.PATH, ":").map((entry) => entry.replace(/\/+$/, ""));
    for (const directory of new Set([
      ...(replaced === undefined ? [] : [path.dirname(replaced)]),
      ...candidates.filter((candidate) => onPath.includes(candidate)),
      ...candidates.filter((candidate) => !onPath.includes(candidate)),
    ])) {
      const link = path.join(directory, "t3");
      const created = (yield* exists(directory))
        ? yield* writableDirectory(directory)
        : yield* fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      if (!created) continue;
      // Our own link is swapped in place; anything else there makes symlink fail and stays.
      const linked = yield* (
        link === replaced
          ? replaceOurLink({ link, target: launcher })
          : fs.symlink(launcher, link).pipe(Effect.as(true))
      ).pipe(Effect.orElseSucceed(() => false));
      if (!linked) continue;
      if (replaced !== undefined && replaced !== link) {
        yield* replaceOurLink({ link: replaced }).pipe(Effect.ignore);
      }
      return yield* state;
    }
    return yield* fail(
      `Another t3 command is already in ~/.local/bin and ~/bin, or neither is writable. Run the launcher directly at ${launcher}.`,
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
    for (const directory of knownLocations(environment.homeDirectory, environment.platform)) {
      const link = path.join(directory, "t3");
      if (yield* isOurLink(link)) {
        yield* replaceOurLink({ link }).pipe(
          Effect.mapError(() => fail(`Could not remove ${link}.`)),
        );
      }
    }
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.uninstall"));

  // One at a time, so Settings and onboarding cannot both append the line.
  const addToPathPermit = yield* Semaphore.make(1);
  const addToPath: DesktopCliCommand["Service"]["addToPath"] = Effect.gen(function* () {
    const installed = yield* installedAt;
    if (Option.isNone(installed) || !(yield* leadsHere(installed.value))) {
      return yield* fail("Install the t3 command first.");
    }
    const setup = startupLine(installed.value);
    if (setup === undefined) return yield* fail("T3 Code cannot add t3 to this shell's PATH.");
    const shadowedBy = yield* foreignFirstOnPath;
    if (Option.isSome(shadowedBy)) {
      return yield* fail(
        `Another t3 at ${shadowedBy.value} runs first; T3 Code leaves it in place.`,
      );
    }
    if (!(yield* folderOnPath(installed.value)) && !(yield* hasLine(setup))) {
      yield* fs.makeDirectory(path.dirname(setup.path), { recursive: true }).pipe(
        Effect.andThen(
          fs.writeFileString(setup.path, `\n# Added by T3 Code\n${setup.line}\n`, { flag: "a" }),
        ),
        Effect.mapError(() => fail(`Could not add t3 to ${setup.file}.`)),
      );
    }
    return yield* state;
  }).pipe(addToPathPermit.withPermits(1), Effect.withSpan("desktop.cliCommand.addToPath"));

  const installOnFirstLaunch: DesktopCliCommand["Service"]["installOnFirstLaunch"] = Effect.gen(
    function* () {
      if (!environment.isPackaged || (yield* exists(firstLaunchMarker))) return;
      // Mark first so a failed or removed install is never retried behind the user's back.
      yield* fs.writeFileString(firstLaunchMarker, "");
      // Another T3 home's app owns the existing link; only Install in Settings may take it over.
      const existing = Option.getOrUndefined(yield* installedAt);
      if (existing !== undefined) {
        const target = yield* fs.readLink(existing).pipe(Effect.option);
        if (Option.getOrUndefined(target) !== launcher) {
          return yield* logInfo("left another T3 Code app's t3 command in place", {
            existing,
          });
        }
      }
      const installed = yield* install;
      yield* logInfo("installed the t3 command on first launch", {
        installedPath: installed.installedPath,
        onPath: installed.onPath,
      });
    },
  ).pipe(
    Effect.catch((error) =>
      logWarning("did not install the t3 command on first launch", { error: String(error) }),
    ),
    Effect.withSpan("desktop.cliCommand.installOnFirstLaunch"),
  );

  return DesktopCliCommand.of({ state, install, uninstall, addToPath, installOnFirstLaunch });
});

export const layer = Layer.effect(DesktopCliCommand, make);
