// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { HostProcessEnvironment, HostProcessPlatform } from "./hostProcess.ts";

const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
const ProcessPlatform = Schema.Literals([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) => string;

function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

export type CommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>;

export class CommandResolutionError extends Schema.TaggedErrorClass<CommandResolutionError>()(
  "CommandResolutionError",
  {
    command: Schema.String,
    platform: ProcessPlatform,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not resolve command ${JSON.stringify(this.command)} on ${this.platform}.`;
  }
}

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escapes a single argument for `cmd.exe` shell mode (`spawn(..., { shell: true })`
 * on Windows). Node joins the command and arguments with spaces and hands the
 * resulting string to `cmd.exe` without any quoting, so every dynamic argument
 * must be escaped to survive both cmd.exe parsing and the target program's
 * `CommandLineToArgvW` parsing. Mirrors cross-spawn's argument escaping.
 */
function escapeWindowsShellArg(arg: string): string {
  // Double up backslashes that precede a double quote, then escape the quote
  // itself so it survives CommandLineToArgvW.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  // Quote the whole argument so embedded whitespace is preserved.
  escaped = `"${escaped}"`;
  // Escape cmd.exe metacharacters so cmd passes them through verbatim.
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

/**
 * Escapes arguments for shell-mode spawns: applies {@link escapeWindowsShellArg}
 * when the platform is `win32` (where `shell: true` routes through `cmd.exe`)
 * and returns the arguments untouched everywhere else.
 */
function sanitizeShellModeArgsForPlatform(
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Array<string> {
  return platform === "win32" ? args.map(escapeWindowsShellArg) : [...args];
}

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined;

function resolveSpawnExecutableWithNode(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const candidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );
  const isExecutable = (candidate: string) => {
    try {
      if (!NodeFS.statSync(candidate).isFile()) return false;
      if (platform === "win32") {
        return windowsPathExtensions.includes(path.extname(candidate).toUpperCase());
      }
      return canExecuteFile(candidate);
    } catch {
      return false;
    }
  };

  if (command.includes("/") || command.includes("\\")) {
    return candidates.find(isExecutable);
  }

  for (const pathEntry of (readEnvPath(env) ?? "").split(pathDelimiterForPlatform(platform))) {
    const normalizedPathEntry = stripWrappingQuotes(pathEntry.trim());
    if (normalizedPathEntry.length === 0) continue;
    for (const candidate of candidates) {
      const candidatePath = path.join(normalizedPathEntry, candidate);
      if (isExecutable(candidatePath)) return candidatePath;
    }
  }
  return undefined;
}

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@t3tools/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

export interface WindowsEnvironmentProbeOptions {
  readonly loadProfile?: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(NodeOS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function extractPathFromShellOutput(output: string): string | null {
  const startIndex = output.indexOf(PATH_CAPTURE_START);
  if (startIndex === -1) return null;

  const valueStartIndex = startIndex + PATH_CAPTURE_START.length;
  const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex);
  if (endIndex === -1) return null;

  const pathValue = output.slice(valueStartIndex, endIndex).trim();
  return pathValue.length > 0 ? pathValue : null;
}

export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  return readEnvironmentFromLoginShell(shell, ["PATH"], execFile).PATH;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry || seen.has(trimmedEntry)) {
        continue;
      }
      seen.add(trimmedEntry);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__T3CODE_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__T3CODE_ENV_${name}_END__`;
}

function buildEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function buildWindowsEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `Write-Output '${envCaptureStart(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${envCaptureEnd(name)}'`,
      ];
    }),
  ].join("; ");
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = NodeChildProcess.execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(names)], {
    encoding: "utf8",
    timeout: 5000,
  });

  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
};

export type WindowsShellEnvironmentReader = (
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
) => Partial<Record<string, string>>;

export const WindowsShellEnvironment = Context.Reference<WindowsShellEnvironmentReader>(
  "@t3tools/shared/shell/WindowsShellEnvironment",
  {
    defaultValue: () => readEnvironmentFromWindowsShell,
  },
);

export const CommandAvailability = Context.Reference<CommandAvailabilityChecker>(
  "@t3tools/shared/shell/CommandAvailability",
  {
    defaultValue: () => isCommandAvailable,
  },
);

export function readEnvironmentFromWindowsShell(
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
): Partial<Record<string, string>>;
export function readEnvironmentFromWindowsShell(
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
  execFile?: ExecFileSyncLike,
): Partial<Record<string, string>>;
export function readEnvironmentFromWindowsShell(
  names: ReadonlyArray<string>,
  optionsOrExecFile?: WindowsEnvironmentProbeOptions | ExecFileSyncLike,
  maybeExecFile?: ExecFileSyncLike,
): Partial<Record<string, string>> {
  if (names.length === 0) {
    return {};
  }

  const options =
    typeof optionsOrExecFile === "function"
      ? ({} satisfies WindowsEnvironmentProbeOptions)
      : (optionsOrExecFile ?? {});
  const execFile: ExecFileSyncLike =
    typeof optionsOrExecFile === "function"
      ? optionsOrExecFile
      : (maybeExecFile ?? (NodeChildProcess.execFileSync as ExecFileSyncLike));
  const command = buildWindowsEnvironmentCaptureCommand(names);
  const args = [
    "-NoLogo",
    ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
    "-NonInteractive",
    "-Command",
    command,
  ];
  for (const shell of WINDOWS_SHELL_CANDIDATES) {
    try {
      const output = execFile(shell, args, { encoding: "utf8", timeout: 5000 });

      const environment: Partial<Record<string, string>> = {};
      for (const name of names) {
        const value = extractEnvironmentValue(output, name);
        if (value !== undefined) {
          environment[name] = value;
        }
      }
      return environment;
    } catch {
      continue;
    }
  }

  return {};
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function normalizePathEntryForComparison(entry: string, platform: NodeJS.Platform): string {
  const normalized = stripWrappingQuotes(entry.trim());
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function mergePathValues(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = pathDelimiterForPlatform(platform);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of [preferredPath, inheritedPath]) {
    if (!rawValue) continue;

    for (const entry of rawValue.split(delimiter)) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      const normalized = normalizePathEntryForComparison(trimmed, platform);
      if (normalized.length === 0 || seen.has(normalized)) continue;

      seen.add(normalized);
      merged.push(trimmed);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return readEnvPath(env) ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed: string[] = [];
  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    parsed.push(trimmed.startsWith(".") ? trimmed.toUpperCase() : `.${trimmed.toUpperCase()}`);
  }
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
  extname: (path: string) => string,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

const isExecutableFile = Effect.fn("shell.isExecutableFile")(function* (
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): Effect.fn.Return<boolean, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fileSystem.stat(filePath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
  );
  if (stat === null || stat.type !== "File") return false;

  if (platform === "win32") {
    const extension = path.extname(filePath);
    if (extension.length === 0) return false;
    return windowsPathExtensions.includes(extension.toUpperCase());
  }

  return canExecuteFile(filePath);
});

const resolveCommandPathForPlatform = Effect.fn("shell.resolveCommandPathForPlatform")(function* (
  command: string,
  options: CommandAvailabilityOptions & { readonly platform: NodeJS.Platform },
): Effect.fn.Return<string, CommandResolutionError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = options.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );
  let firstProbeFailure: PlatformError.PlatformError | undefined;
  const probeCandidate = (candidatePath: string) =>
    isExecutableFile(candidatePath, platform, windowsPathExtensions).pipe(
      Effect.catch((cause) => {
        firstProbeFailure ??= cause;
        return Effect.succeed(false);
      }),
    );

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of commandCandidates) {
      if (yield* probeCandidate(candidate)) {
        return candidate;
      }
    }
    return yield* new CommandResolutionError({
      command,
      platform,
      ...(firstProbeFailure === undefined ? {} : { cause: firstProbeFailure }),
    });
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) {
    return yield* new CommandResolutionError({ command, platform });
  }
  const pathEntries: string[] = [];
  for (const entry of pathValue.split(pathDelimiterForPlatform(platform))) {
    const pathEntry = stripWrappingQuotes(entry.trim());
    if (pathEntry.length > 0) {
      pathEntries.push(pathEntry);
    }
  }

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      const candidatePath = path.join(pathEntry, candidate);
      if (yield* probeCandidate(candidatePath)) {
        return candidatePath;
      }
    }
  }
  return yield* new CommandResolutionError({
    command,
    platform,
    ...(firstProbeFailure === undefined ? {} : { cause: firstProbeFailure }),
  });
});

export const resolveCommandPath = Effect.fn("shell.resolveCommandPath")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return yield* resolveCommandPathForPlatform(command, {
    env: options.env ?? (yield* HostProcessEnvironment),
    platform: yield* HostProcessPlatform,
  });
});

export const resolveSpawnCommand = Effect.fn("shell.resolveSpawnCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand> {
  const platform = yield* HostProcessPlatform;
  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcessEnvironment;
  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolvedCommand = resolveExecutable(command, platform, env) ?? command;
  const extension = NodePath.win32.extname(resolvedCommand).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }

  return {
    command: escapeWindowsShellArg(resolvedCommand),
    args: sanitizeShellModeArgsForPlatform(args, platform),
    shell: true,
  };
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return yield* resolveCommandPath(command, options).pipe(
    Effect.as(true),
    Effect.catchTags({
      CommandResolutionError: () => Effect.succeed(false),
    }),
  );
});

export function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();

  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData ? [`${localAppData}\\Programs\\nodejs`, `${localAppData}\\Volta\\bin`] : []),
    ...(localAppData ? [`${localAppData}\\pnpm`] : []),
    ...(userProfile ? [`${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`] : []),
  ];
}

function readWindowsEnvironmentSafely(
  readEnvironment: WindowsShellEnvironmentReader,
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
): Partial<Record<string, string>> {
  try {
    return readEnvironment(names, options);
  } catch {
    return {};
  }
}

function mergeWindowsEnv(
  currentEnv: NodeJS.ProcessEnv,
  patch: Partial<Record<string, string>>,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...currentEnv };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

export const resolveWindowsEnvironment = Effect.fn("shell.resolveWindowsEnvironment")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Partial<NodeJS.ProcessEnv>, never, FileSystem.FileSystem | Path.Path> {
  const readEnvironment = yield* WindowsShellEnvironment;
  const commandAvailable = yield* CommandAvailability;
  const inheritedPath = readEnvPath(env);
  const shellPath = readWindowsEnvironmentSafely(readEnvironment, ["PATH"], {
    loadProfile: false,
  }).PATH;
  const mergedPath = mergePathValues(shellPath, inheritedPath, "win32");
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  const baselinePath = mergePathValues(knownCliPath, mergedPath, "win32");
  const baselinePatch: Partial<NodeJS.ProcessEnv> = baselinePath ? { PATH: baselinePath } : {};
  const baselineEnv = mergeWindowsEnv(env, baselinePatch);

  if (yield* commandAvailable("node", { env: baselineEnv })) {
    return baselinePatch;
  }

  const profiledEnvironment = readWindowsEnvironmentSafely(
    readEnvironment,
    ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
    { loadProfile: true },
  );
  const profiledPath = mergePathValues(profiledEnvironment.PATH, baselinePath, "win32");
  const profiledPatch: Partial<NodeJS.ProcessEnv> = {
    ...(profiledPath ? { PATH: profiledPath } : {}),
    ...(profiledEnvironment.FNM_DIR ? { FNM_DIR: profiledEnvironment.FNM_DIR } : {}),
    ...(profiledEnvironment.FNM_MULTISHELL_PATH
      ? { FNM_MULTISHELL_PATH: profiledEnvironment.FNM_MULTISHELL_PATH }
      : {}),
  };
  return Object.keys(profiledPatch).length > 0
    ? { ...baselinePatch, ...profiledPatch }
    : baselinePatch;
});
