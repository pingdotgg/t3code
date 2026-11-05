// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.access has no execute check.
import * as NodeFSP from "node:fs/promises";

import type { DesktopCliCommandState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
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
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export class DesktopCliCommandError extends Schema.TaggedError<DesktopCliCommandError>()(
  "DesktopCliCommandError",
  { message: Schema.String },
) {}
const isDesktopCliCommandError = Schema.is(DesktopCliCommandError);

const unixCandidates = (home: string, platform: NodeJS.Platform) =>
  platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`]
    : [`${home}/.local/bin`, `${home}/bin`];

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
    readonly installWsl: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
    readonly uninstallWsl: Effect.Effect<DesktopCliCommandState, DesktopCliCommandError>;
  }
>()("@t3tools/desktop/app/DesktopCliCommand") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Read the live env: shell discovery patches PATH after startup, and Windows variable
  // names are case-insensitive only on process.env, not on Config's copy of it.
  const env = yield* HostProcess.Environment;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const launcher = DesktopCliShim.launcherPath(environment);
  const binDirectory = path.dirname(launcher);
  const ownedPathMarker = path.join(environment.stateDir, "cli-command-path-entry");
  const wslInstalledMarker = path.join(environment.stateDir, "cli-command-wsl-installed");

  const runWslScript = Effect.fn("DesktopCliCommand.runWslScript")(function* (
    distro: string | null,
    script: string,
    quick = false,
  ) {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const args = [...(distro ? ["--distribution", distro] : []), "--exec", "sh", "-s"];
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("wsl.exe", args, {
              stdin: Stream.encodeText(Stream.make(script)),
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              env: { WSL_UTF8: "1" },
              extendEnv: true,
            }),
          )
          .pipe(Effect.mapError((error) => fail(error.message)));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(exitCode) !== 0) {
          return yield* fail(
            stderr.trim() ||
              stdout.trim() ||
              `Could not run WSL${distro ? ` in ${distro}` : ""}. Check that the distro is available.`,
          );
        }
        return stdout.trim();
      }),
    ).pipe(
      Effect.timeoutOption(Duration.seconds(quick ? 2 : 30)),
      Effect.mapError((error) =>
        isDesktopCliCommandError(error)
          ? error
          : fail("WSL did not respond. Check that the configured distro is available."),
      ),
    );
    return yield* Effect.fromOption(result, () =>
      fail("WSL did not respond. Check that the configured distro is available."),
    );
  });

  const fail = (message: string) => new DesktopCliCommandError({ message });
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  const writableDirectory = (directory: string) =>
    fs.access(directory, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const isOurLink = Effect.fn("DesktopCliCommand.isOurLink")(
    function* (link: string) {
      yield* fs.readLink(link);
      // The launcher is a few KB; never read a large binary another `t3` links to.
      const info = yield* fs.stat(link);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      const content = yield* fs.readFileString(link);
      return content.includes(DesktopCliShim.MARKER);
    },
    Effect.orElseSucceed(() => false),
  );

  // PATH can reach the regular launcher directly; removal still requires isOurLink.
  const runsOurLauncher = Effect.fn("DesktopCliCommand.runsOurLauncher")(
    function* (candidate: string) {
      if (yield* isOurLink(candidate)) return true;
      const [resolved, ours] = yield* Effect.all([fs.realPath(candidate), fs.realPath(launcher)]);
      if (resolved !== ours) return false;
      const info = yield* fs.stat(candidate);
      if (info.type !== "File" || Number(info.size) > 16_384) return false;
      return (yield* fs.readFileString(candidate)).includes(DesktopCliShim.MARKER);
    },
    Effect.orElseSucceed(() => false),
  );

  const powershell = (overrides: Record<string, string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = env.SystemRoot ?? env.WINDIR;
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_PATH_SCRIPT],
            { stdin: "ignore", stderr: "ignore", env: overrides, extendEnv: true },
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

  const isExecutableFile = Effect.fn("DesktopCliCommand.isExecutableFile")(
    function* (target: string) {
      if ((yield* fs.stat(target)).type !== "File") return false;
      yield* Effect.tryPromise(() => NodeFSP.access(target, NodeFSP.constants.X_OK));
      return true;
    },
    Effect.orElseSucceed(() => false),
  );

  const firstOnPath = Effect.gen(function* () {
    for (const directory of pathEntries(env.PATH, ":")) {
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
      return {
        supported: false,
        installedPath: null,
        onPath: false,
        wslSupported: false,
        wslBackendEnabled: false,
        wslInstalledPath: null,
        wslInstalledDistro: null,
        wslStatusUnavailable: false,
        launcherPath: null,
      } as const;
    }
    const launcherPath = (yield* exists(launcher)) ? launcher : null;
    const installed = yield* installedAt;
    const shadowedBy = yield* foreignFirstOnPath;
    const shadow = Option.isSome(shadowedBy) ? { shadowedBy: shadowedBy.value } : {};
    const first = yield* firstOnPath;
    const onPath = windows
      ? Option.isSome(installed)
      : Option.isSome(first) && (yield* runsOurLauncher(first.value));
    const desktopSettingsState = windows ? yield* desktopSettings.get : null;
    const wslState = windows
      ? yield* Effect.gen(function* () {
          const record = yield* fs.readFileString(wslInstalledMarker).pipe(Effect.option);
          if (Option.isNone(record)) return { path: null, distro: null, unavailable: false };
          const [distro, installedPath] = record.value.split("\n");
          const status = yield* runWslScript(
            distro || null,
            DesktopCliShim.renderWslCliInstallScript({ action: "state", windowsCliPath: launcher }),
            true,
          ).pipe(Effect.option);
          if (Option.isNone(status))
            return {
              path: installedPath || null,
              distro: distro || null,
              unavailable: true,
            };
          const [actualPath] = status.value.split("\n");
          return {
            path: actualPath === "NONE" ? null : actualPath || null,
            distro: actualPath === "NONE" ? null : distro || null,
            unavailable: false,
          };
        })
      : { path: null, distro: null, unavailable: false };
    return {
      supported: true,
      installedPath: Option.getOrNull(installed),
      onPath,
      wslSupported: windows,
      wslBackendEnabled: desktopSettingsState?.wslBackendEnabled === true,
      wslInstalledPath: wslState.path,
      wslInstalledDistro: wslState.distro,
      wslStatusUnavailable: wslState.unavailable,
      launcherPath,
      ...shadow,
    };
  }).pipe(
    Effect.orElseSucceed(() => ({
      supported: false,
      installedPath: null,
      onPath: false,
      wslSupported: false,
      wslBackendEnabled: false,
      wslInstalledPath: null,
      wslInstalledDistro: null,
      wslStatusUnavailable: false,
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
      const entries = pathEntries(yield* readUserPath, ";");
      if (!entries.some((entry) => sameWindowsPath(entry, binDirectory))) {
        yield* writeUserPath([...entries, binDirectory].join(";"));
        yield* fs
          .writeFileString(ownedPathMarker, `${binDirectory}\n`)
          .pipe(Effect.mapError(() => fail("Added t3 to your PATH but could not record it.")));
      }
      return yield* state;
    }
    const existing = yield* installedAt;
    if (Option.isSome(existing)) {
      const target = yield* fs.readLink(existing.value).pipe(Effect.option);
      if (Option.getOrUndefined(target) === launcher) return yield* state;
      yield* fs
        .remove(existing.value)
        .pipe(Effect.mapError(() => fail(`Could not replace ${existing.value}.`)));
    }
    const shadowedBy = yield* foreignFirstOnPath;
    if (Option.isSome(shadowedBy)) {
      return yield* fail(
        `Another t3 at ${shadowedBy.value} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`,
      );
    }
    const onPath = pathEntries(env.PATH, ":");
    const candidates = unixCandidates(environment.homeDirectory, environment.platform);
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

  const installWsl: DesktopCliCommand["Service"]["installWsl"] = Effect.gen(function* () {
    if (!windows)
      return yield* fail("The WSL t3 command is available from the Windows desktop app.");
    if (!environment.isPackaged) return yield* fail("The t3 command needs an installed app.");
    const settings = yield* desktopSettings.get;
    if (!settings.wslBackendEnabled)
      return yield* fail("Enable the WSL backend before installing its t3 command.");
    yield* ensureLauncher;
    const status = yield* runWslScript(
      settings.wslDistro,
      DesktopCliShim.renderWslCliInstallScript({ action: "install", windowsCliPath: launcher }),
    );
    const [installedPath, installedDistro] = status.split("\n");
    if (!installedDistro || !installedPath || installedPath === "NONE")
      return yield* fail("Could not verify the WSL t3 command installation.");
    yield* fs
      .writeFileString(wslInstalledMarker, `${installedDistro}\n${installedPath}\n`)
      .pipe(Effect.mapError(() => fail("Could not record the WSL t3 command installation.")));
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.installWsl"));

  const uninstallWsl: DesktopCliCommand["Service"]["uninstallWsl"] = Effect.gen(function* () {
    if (!windows)
      return yield* fail("The WSL t3 command is available from the Windows desktop app.");
    const settings = yield* desktopSettings.get;
    const record = yield* fs.readFileString(wslInstalledMarker).pipe(Effect.option);
    const distro = Option.isSome(record) ? record.value.split("\n")[0] || null : settings.wslDistro;
    yield* runWslScript(
      distro,
      DesktopCliShim.renderWslCliInstallScript({
        action: "uninstall",
        windowsCliPath: launcher,
      }),
    );
    yield* fs.remove(wslInstalledMarker).pipe(Effect.ignore);
    return yield* state;
  }).pipe(Effect.withSpan("desktop.cliCommand.uninstallWsl"));

  return DesktopCliCommand.of({ state, install, uninstall, installWsl, uninstallWsl });
});

export const layer = Layer.effect(DesktopCliCommand, make);
