/**
 * ExternalLauncher - external application launch service interface.
 *
 * Owns process launch helpers for browser URLs and workspace paths
 * in configured editor integrations.
 *
 * @module ExternalLauncher
 */
import {
  EDITORS,
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  type EditorId,
  type FileManagerRevealKind,
  type LaunchEditorInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

// ==============================
// Definitions
// ==============================

export {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  isExternalLauncherError,
} from "@t3tools/contracts";
export type { LaunchEditorInput };
interface EditorLaunch {
  readonly editor: EditorId;
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

const BrowserLaunchEnvConfig = Config.all({
  SYSTEMROOT: Config.string("SYSTEMROOT").pipe(Config.option),
  windir: Config.string("windir").pipe(Config.option),
  WSL_DISTRO_NAME: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
  WSL_INTEROP: Config.string("WSL_INTEROP").pipe(Config.option),
  SSH_CONNECTION: Config.string("SSH_CONNECTION").pipe(Config.option),
  SSH_TTY: Config.string("SSH_TTY").pipe(Config.option),
  container: Config.string("container").pipe(Config.option),
  DISPLAY: Config.string("DISPLAY").pipe(Config.option),
  WAYLAND_DISPLAY: Config.string("WAYLAND_DISPLAY").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

const readBrowserLaunchEnv = BrowserLaunchEnvConfig.pipe(Effect.orElseSucceed(() => ({})));
const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

const resolveAvailableCommand = Effect.fn("externalLauncher.resolveAvailableCommand")(function* (
  commands: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  for (const command of commands) {
    if (yield* isCommandAvailable(command, { env })) {
      return Option.some(command);
    }
  }
  return Option.none();
});

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

function escapePowerShellStringLiteral(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function resolvePowerShellPath(env: NodeJS.ProcessEnv = {}): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function resolveWslPowerShellPath(): string {
  return "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
}

// File reveals from WSL resolve PowerShell through the interop PATH rather
// than the fixed /mnt/c mount: the automount root is configurable, and a
// PATH-resolved command keeps the advertised capability aligned with the
// availability check `launchEditor` performs before spawning.
const WSL_POWERSHELL_COMMAND = "powershell.exe";

function shouldUseWindowsHostFromWsl(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): boolean {
  return (
    platform === "linux" &&
    (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) &&
    env.SSH_CONNECTION === undefined &&
    env.SSH_TTY === undefined &&
    env.container === undefined
  );
}

function resolveWindowsBrowserLaunch(target: string, command: string): ProcessLaunch {
  const encodedCommand = encodeUtf16LeBase64(
    `$ProgressPreference = 'SilentlyContinue'; Start ${escapePowerShellStringLiteral(target)}`,
  );
  return {
    command,
    args: [...POWERSHELL_ARGUMENTS_PREFIX, encodedCommand],
    options: {
      detached: true,
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  };
}

function hasGraphicalLinuxSession(env: NodeJS.ProcessEnv): boolean {
  return [env.DISPLAY, env.WAYLAND_DISPLAY].some(
    (value) => value !== undefined && value.trim().length > 0,
  );
}

function fileManagerCommandForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      if (shouldUseWindowsHostFromWsl(platform, env)) {
        return env.WSL_DISTRO_NAME?.trim() ? "explorer.exe" : undefined;
      }
      return hasGraphicalLinuxSession(env) ? "xdg-open" : undefined;
  }
}

// A graphical session variable plus an executable `xdg-open` does not prove
// that opening a directory does anything: without an `inode/directory` MIME
// handler, `xdg-open` exits nonzero after the launcher has already detached,
// so the client would see a silent no-op. Require the handler before
// advertising the file manager on Linux.
//
// The probe carries its own timeout well inside the scan timeout
// `server.getConfig` applies to editor discovery: that outer timeout degrades
// to an empty editor list, so a hung `xdg-mime` (broken D-Bus or desktop
// session) must cost only the file manager, not every discovered editor.
const LINUX_DIRECTORY_HANDLER_PROBE_TIMEOUT = "2 seconds";

const hasUsableLinuxDirectoryHandler = Effect.fn("externalLauncher.hasUsableLinuxDirectoryHandler")(
  function* (
    env: NodeJS.ProcessEnv,
  ): Effect.fn.Return<
    boolean,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    if (!(yield* isCommandAvailable("xdg-mime", { env }))) {
      return false;
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner
      .spawn(
        ChildProcess.make("xdg-mime", ["query", "default", "inode/directory"], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.flatMap((handle) =>
          Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], {
            concurrency: "unbounded",
          }),
        ),
        Effect.map(([stdout, exitCode]) => exitCode === 0 && stdout.trim().length > 0),
        Effect.scoped,
        Effect.timeout(LINUX_DIRECTORY_HANDLER_PROBE_TIMEOUT),
        Effect.orElseSucceed(() => false),
      );
  },
);

const isUsableFileManagerCommand = Effect.fn("externalLauncher.isUsableFileManagerCommand")(
  function* (
    command: string,
    env: NodeJS.ProcessEnv,
  ): Effect.fn.Return<
    boolean,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    if (!(yield* isCommandAvailable(command, { env }))) {
      return false;
    }
    return command !== "xdg-open" || (yield* hasUsableLinuxDirectoryHandler(env));
  },
);

// The file-manager command a launch can actually run, not just the platform
// preference. WSL hosts prefer the Windows Explorer bridge, but interop can
// exist without `explorer.exe` on PATH (appendWindowsPath=false) or without a
// distro name while WSLg still provides a working Linux file manager, so they
// keep the `xdg-open` fallback instead of losing the editor entirely.
const resolveUsableFileManagerCommand = Effect.fn(
  "externalLauncher.resolveUsableFileManagerCommand",
)(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<
  string | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const command = fileManagerCommandForPlatform(platform, env);
  if (command !== undefined && (yield* isUsableFileManagerCommand(command, env))) {
    return command;
  }
  if (
    shouldUseWindowsHostFromWsl(platform, env) &&
    hasGraphicalLinuxSession(env) &&
    (yield* isUsableFileManagerCommand("xdg-open", env))
  ) {
    return "xdg-open";
  }
  return undefined;
});

// Reveal on Windows and WSL runs through PowerShell (see
// resolveFileManagerRevealLaunch), not the `explorer` command that gates the
// file-manager editor itself, so the capability must probe the executables the
// reveal actually spawns. Callers gate on file-manager availability first;
// the Linux "files" kind relies on that gate for the directory-handler probe,
// while the WSL fallback re-probes because its availability may have come
// from the Explorer bridge instead.
const fileManagerRevealKindForPlatform = Effect.fn(
  "externalLauncher.fileManagerRevealKindForPlatform",
)(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<
  FileManagerRevealKind | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  if (platform === "darwin") return "finder";
  if (platform === "win32") {
    return (yield* isCommandAvailable(resolvePowerShellPath(env), { env }))
      ? "file-explorer"
      : undefined;
  }
  if (shouldUseWindowsHostFromWsl(platform, env)) {
    if (
      env.WSL_DISTRO_NAME?.trim() &&
      (yield* isCommandAvailable("explorer.exe", { env })) &&
      (yield* isCommandAvailable(WSL_POWERSHELL_COMMAND, { env }))
    ) {
      return "file-explorer";
    }
    return hasGraphicalLinuxSession(env) && (yield* isUsableFileManagerCommand("xdg-open", env))
      ? "files"
      : undefined;
  }
  return hasGraphicalLinuxSession(env) ? "files" : undefined;
});

function resolveWslFileManagerPath(target: string, distroName: string): string {
  const relativePath = target.replace(/^\/+/, "").replaceAll("/", "\\");
  return `\\\\wsl.localhost\\${distroName}${relativePath.length > 0 ? `\\${relativePath}` : ""}`;
}

function buildBrowserLaunch(
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {},
): ProcessLaunch {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [target],
      options: DETACHED_IGNORE_STDIO_OPTIONS,
    };
  }

  if (platform === "win32") {
    return resolveWindowsBrowserLaunch(target, resolvePowerShellPath(env));
  }

  if (shouldUseWindowsHostFromWsl(platform, env)) {
    return resolveWindowsBrowserLaunch(target, resolveWslPowerShellPath());
  }

  return {
    command: "xdg-open",
    args: [target],
    options: DETACHED_IGNORE_STDIO_OPTIONS,
  };
}

const buildAvailableEditors = Effect.fn("externalLauncher.buildAvailableEditors")(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReadonlyArray<EditorId>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.commands === null) {
      if ((yield* resolveUsableFileManagerCommand(platform, env)) !== undefined) {
        available.push(editor.id);
      }
      continue;
    }

    const command = yield* resolveAvailableCommand(editor.commands, env);
    if (Option.isSome(command)) {
      available.push(editor.id);
    }
  }

  return available;
});

const resolveBrowserLaunch = Effect.fn("externalLauncher.resolveBrowserLaunch")(function* (
  target: string,
) {
  const platform = yield* HostProcessPlatform;
  const env = yield* readBrowserLaunchEnv;
  return buildBrowserLaunch(target, platform, env);
});

const resolveAvailableEditors = Effect.fn("externalLauncher.resolveAvailableEditors")(function* () {
  const platform = yield* HostProcessPlatform;
  const env = { ...(yield* readBrowserLaunchEnv), ...(yield* readCommandLookupEnv) };
  return yield* buildAvailableEditors(platform, env);
});

const resolveFileManagerRevealKind = Effect.fn("externalLauncher.resolveFileManagerRevealKind")(
  function* () {
    const platform = yield* HostProcessPlatform;
    const env = { ...(yield* readBrowserLaunchEnv), ...(yield* readCommandLookupEnv) };
    return yield* fileManagerRevealKindForPlatform(platform, env);
  },
);

// Editor discovery walks PATH for every known editor and runs for every
// client connect (the server config embeds the available editors). Memoize
// the discovered set for a bounded window so repeat connects skip even the
// per-command cache lookups in @t3tools/shared/shell.
//
// This deliberately does not use `Effect.cachedWithTTL`: that memoizes the
// first caller's Exit whatever it is, including an interrupt. Callers run this
// on the connection fiber under a timeout (`resolveAvailableEditorsForConfig`),
// so one client disconnecting mid-scan would cache the interrupt and replay it
// to every later connect for the whole TTL, breaking `server.getConfig`
// permanently. Storing only on success means an interrupted scan leaves the
// cache untouched and the next connect simply rescans.
// Expiry uses the monotonic clock (Clock.currentTimeNanos), matching the
// command-resolution cache in @t3tools/shared/shell, so a backward wall-clock
// adjustment cannot keep an expired entry alive.
const EDITOR_DISCOVERY_CACHE_TTL_NANOS = 60_000_000_000n;

interface EditorDiscoveryCacheEntry {
  readonly editors: ReadonlyArray<EditorId>;
  readonly expiresAtNanos: bigint;
}

/**
 * ExternalLauncher - Service tag for browser/editor launch operations.
 */
export class ExternalLauncher extends Context.Service<
  ExternalLauncher,
  {
    readonly resolveAvailableEditors: () => Effect.Effect<ReadonlyArray<EditorId>>;
    /**
     * Reveal kind for the host, or undefined when the executable a reveal
     * actually spawns is unavailable. Only meaningful when
     * `resolveAvailableEditors` includes "file-manager": on Linux that
     * availability check also carries the directory-handler probe this
     * capability relies on.
     */
    readonly resolveFileManagerRevealKind: () => Effect.Effect<FileManagerRevealKind | undefined>;
    /** Launch a URL target in the default browser. */
    readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;
    /**
     * Launch a workspace path in a selected editor integration.
     *
     * Launches the editor as a detached process so server startup is not blocked.
     */
    readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
  }
>()("t3/process/externalLauncher") {}

// ==============================
// Implementations
// ==============================

const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
): Effect.fn.Return<
  EditorLaunch,
  ExternalLauncherError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const platform = yield* HostProcessPlatform;
  const env = { ...(yield* readBrowserLaunchEnv), ...(yield* readCommandLookupEnv) };
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherUnknownEditorError({ editor: input.editor });
  }

  if (editorDef.commands) {
    const command = Option.getOrElse(
      yield* resolveAvailableCommand(editorDef.commands, env),
      () => editorDef.commands[0],
    );
    return {
      editor: editorDef.id,
      target: input.cwd,
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  const command = yield* resolveUsableFileManagerCommand(platform, env);
  if (command === undefined) {
    return yield* new ExternalLauncherUnsupportedEditorError({ editor: input.editor });
  }

  if (input.reveal === true) {
    return yield* resolveFileManagerRevealLaunch(input.cwd, platform, env, command);
  }

  return {
    editor: editorDef.id,
    target: input.cwd,
    command,
    args:
      command === "explorer.exe" && env.WSL_DISTRO_NAME !== undefined
        ? [resolveWslFileManagerPath(input.cwd, env.WSL_DISTRO_NAME)]
        : [input.cwd],
  };
});

/**
 * PowerShell source that launches File Explorer with its raw selection
 * switch. Explorer's contract is the single argument `/select,"<path>"` with
 * only the path quoted; Node's default spawn quoting wraps the whole argument
 * when the path has spaces and Explorer misparses it, silently opening a
 * fallback folder. A single `-ArgumentList` string in Windows PowerShell 5.1
 * reaches the child's command line verbatim, preserving the raw switch.
 *
 * Exported so the Windows smoke test can drive the identical source through a
 * real PowerShell against a recording stub instead of Explorer.
 */
export function buildFileExplorerRevealPowerShellSource(
  explorerCommand: string,
  target: string,
): string {
  return `$ProgressPreference = 'SilentlyContinue'; Start-Process ${escapePowerShellStringLiteral(explorerCommand)} -ArgumentList ('/select,"' + ${escapePowerShellStringLiteral(target)} + '"')`;
}

function fileExplorerRevealLaunch(
  target: string,
  explorerTarget: string,
  powershellCommand: string,
): EditorLaunch {
  return {
    editor: "file-manager",
    target,
    command: powershellCommand,
    args: [
      ...POWERSHELL_ARGUMENTS_PREFIX,
      encodeUtf16LeBase64(buildFileExplorerRevealPowerShellSource("explorer.exe", explorerTarget)),
    ],
  };
}

function normalizeWindowsFileManagerPath(target: string): string {
  return target.replaceAll("/", "\\");
}

const resolveFileManagerRevealLaunch = Effect.fn("resolveFileManagerRevealLaunch")(function* (
  target: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  // The command resolveUsableFileManagerCommand picked; a WSL host that fell
  // back to the Linux file manager must reveal through it as well.
  command: string,
): Effect.fn.Return<
  EditorLaunch,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  if (platform === "darwin") {
    return { editor: "file-manager", target, command: "open", args: ["-R", target] };
  }

  if (platform === "win32") {
    return fileExplorerRevealLaunch(
      target,
      normalizeWindowsFileManagerPath(target),
      resolvePowerShellPath(env),
    );
  }

  if (
    command === "explorer.exe" &&
    shouldUseWindowsHostFromWsl(platform, env) &&
    env.WSL_DISTRO_NAME !== undefined
  ) {
    const explorerTarget = resolveWslFileManagerPath(target, env.WSL_DISTRO_NAME);
    if (yield* isCommandAvailable(WSL_POWERSHELL_COMMAND, { env })) {
      // Explorer's raw switch cannot express a double quote, and unlike
      // Windows paths a WSL path may legally contain one: open the containing
      // directory in File Explorer instead, matching the advertised
      // "file-explorer" kind.
      if (explorerTarget.includes('"')) {
        const path = yield* Path.Path;
        return {
          editor: "file-manager",
          target,
          command: "explorer.exe",
          args: [resolveWslFileManagerPath(path.dirname(target), env.WSL_DISTRO_NAME)],
        };
      }
      return fileExplorerRevealLaunch(target, explorerTarget, WSL_POWERSHELL_COMMAND);
    }
    // Without interop PowerShell the capability advertised the Linux "files"
    // kind when it advertised anything at all, so the reveal must open the
    // Linux file manager the label promised, not File Explorer.
    if (hasGraphicalLinuxSession(env) && (yield* isUsableFileManagerCommand("xdg-open", env))) {
      const path = yield* Path.Path;
      return { editor: "file-manager", target, command: "xdg-open", args: [path.dirname(target)] };
    }
    // Nothing was advertised here; open the parent in File Explorer as the
    // best remaining effort for a stale client.
    const path = yield* Path.Path;
    return {
      editor: "file-manager",
      target,
      command: "explorer.exe",
      args: [resolveWslFileManagerPath(path.dirname(target), env.WSL_DISTRO_NAME)],
    };
  }

  // Linux file managers have no portable "select this file" flag, so open
  // the containing directory instead.
  const path = yield* Path.Path;
  return { editor: "file-manager", target, command, args: [path.dirname(target)] };
});

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  onError: (cause: unknown) => ExternalLauncherError,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError(onError),
  );
});

const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const launch = yield* resolveBrowserLaunch(target);
  return yield* launchAndUnref(
    launch,
    (cause) =>
      new ExternalLauncherBrowserSpawnError({
        target,
        command: launch.command,
        args: launch.args,
        cause,
      }),
  );
});

const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<
  void,
  ExternalLauncherError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const env = yield* readCommandLookupEnv;
  if (!(yield* isCommandAvailable(launch.command, { env }))) {
    return yield* new ExternalLauncherCommandNotFoundError({
      editor: launch.editor,
      command: launch.command,
    });
  }

  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, { env });
  yield* launchAndUnref(
    {
      command: spawnCommand.command,
      args: spawnCommand.args,
      options: {
        detached: true,
        shell: spawnCommand.shell,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    },
    (cause) =>
      new ExternalLauncherEditorSpawnError({
        editor: launch.editor,
        target: launch.target,
        command: spawnCommand.command,
        args: spawnCommand.args,
        cause,
      }),
  );
});

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const provideCommandResolutionServices = <A, E, R>(
    effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const editorDiscoveryCache = yield* Ref.make<Option.Option<EditorDiscoveryCacheEntry>>(
    Option.none(),
  );
  const cachedAvailableEditors = Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos;
    const entry = yield* Ref.get(editorDiscoveryCache);
    if (Option.isSome(entry) && entry.value.expiresAtNanos > nowNanos) {
      return entry.value.editors;
    }
    const editors = yield* provideCommandResolutionServices(resolveAvailableEditors()).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    yield* Ref.set(
      editorDiscoveryCache,
      Option.some({
        editors,
        expiresAtNanos: nowNanos + EDITOR_DISCOVERY_CACHE_TTL_NANOS,
      }),
    );
    return editors;
  });

  return ExternalLauncher.of({
    resolveAvailableEditors: () => cachedAvailableEditors,
    resolveFileManagerRevealKind: () =>
      provideCommandResolutionServices(resolveFileManagerRevealKind()).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchBrowser: (target) =>
      launchBrowser(target).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchEditor: (input) =>
      provideCommandResolutionServices(
        Effect.flatMap(resolveEditorLaunch(input), launchEditorProcess),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  });
});

export const layer = Layer.effect(ExternalLauncher, make);
