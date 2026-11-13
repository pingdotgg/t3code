// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { WindowsEnvironmentProbeOptions } from "./shell.ts";

const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;

export const WINDOWS_PATH_DELIMITER = ";";

const POSIX_PATH_DELIMITER = ":";

const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;

const WINDOWS_SHELL_PROBE_TIMEOUT_MS = 5000;

// A shell stuck in the kernel survives the kill and holds stdout, so execFile's callback never fires.
const WINDOWS_SHELL_PROBE_DEADLINE = Duration.millis(WINDOWS_SHELL_PROBE_TIMEOUT_MS + 1000);

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    encoding: "utf8";
    timeout: number;
    killSignal?: NodeJS.Signals | number;
    detached?: true;
    stdio?: ["ignore", "pipe", "ignore"];
  },
) => string;

export function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export // Escape dynamic arguments for both cmd.exe and the target's CommandLineToArgvW parsing.
function escapeWindowsShellArg(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export function resolveSpawnExecutableWithNode(
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

export function buildEnvironmentCaptureCommand(
  shell: string,
  names: ReadonlyArray<string>,
): string {
  const executableName = NodePath.basename(shell).toLowerCase();
  const isNushell = executableName.startsWith("nu");

  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      if (isNushell) {
        // Without a configured conversion, Nu expands home paths only in a list PATH.
        const defaultValue =
          name === "PATH"
            ? "if ($env.PATH? | describe | str starts-with 'list') { " +
              "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
              "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
              "} else { $env.PATH? | default '' }"
            : `$env.${name}? | default ''`;
        const value =
          `if $env.${name}? == null { '' } else if ` +
          `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
          `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
          `} else { ${defaultValue} }`;
        return [
          `print '${envCaptureStart(name)}'`,
          `print (${value})`,
          `print '${envCaptureEnd(name)}'`,
        ].join("; ");
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

  // Interactive startup loads PATH entries; detaching prevents job control on an
  // inherited controlling TTY from stopping the probe while the parent waits.
  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, names)], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
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

const execWindowsEnvironmentProbe = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) =>
  Effect.callback<Option.Option<string>>((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.execFile(
        file,
        args,
        { ...options, windowsHide: true },
        (error, stdout) => {
          resume(Effect.succeed(error ? Option.none() : Option.some(stdout)));
        },
      );
    } catch {
      resume(Effect.succeedNone);
      return;
    }
    return Effect.sync(() => {
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    });
  });

export const readEnvironmentFromWindowsShell = Effect.fn("shell.readEnvironmentFromWindowsShell")(
  function* (
    names: ReadonlyArray<string>,
    options: WindowsEnvironmentProbeOptions = {},
    execFile: typeof execWindowsEnvironmentProbe = execWindowsEnvironmentProbe,
  ) {
    if (names.length === 0) return {};

    const command = buildWindowsEnvironmentCaptureCommand(names);
    const args = [
      "-NoLogo",
      ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
      "-NonInteractive",
      "-Command",
      command,
    ];
    for (const shell of WINDOWS_SHELL_CANDIDATES) {
      const output = yield* execFile(shell, args, {
        encoding: "utf8",
        timeout: WINDOWS_SHELL_PROBE_TIMEOUT_MS,
      }).pipe(Effect.timeoutOption(WINDOWS_SHELL_PROBE_DEADLINE), Effect.map(Option.flatten));
      if (Option.isNone(output)) continue;

      const environment: Partial<Record<string, string>> = {};
      for (const name of names) {
        const value = extractEnvironmentValue(output.value, name);
        if (value !== undefined) environment[name] = value;
      }
      return environment;
    }

    return {};
  },
);

export function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

export function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function normalizePathEntryForComparison(entry: string, platform: NodeJS.Platform): string {
  const normalized = stripWrappingQuotes(entry.trim());
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sanitizePathEntry(entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? entry.replaceAll('"', "") : entry;
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
      const sanitized = sanitizePathEntry(entry.trim(), platform);
      if (sanitized.length === 0) continue;

      const normalized = normalizePathEntryForComparison(sanitized, platform);
      if (normalized.length === 0 || seen.has(normalized)) continue;

      seen.add(normalized);
      merged.push(sanitized);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

export function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

export function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return readEnvPath(env) ?? "";
}

export function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
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

export function resolveCommandCandidates(
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

export // Explicit paths bypass the cache for new installs; cached misses can otherwise hide binaries for 30 seconds.
const COMMAND_RESOLUTION_CACHE_TTL_NANOS = 30_000_000_000n;

export const COMMAND_RESOLUTION_CACHE_MAX_ENTRIES = 512;

export const COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR = String.fromCharCode(0);
