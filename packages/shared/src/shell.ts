import * as OS from "node:os";
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

const PATH_CAPTURE_START = "__T3CODE_PATH_START__";
const PATH_CAPTURE_END = "__T3CODE_PATH_END__";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) => string;

export interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WindowsEnvironmentProbeOptions {
  readonly loadProfile?: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(OS.userInfo().shell);
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
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  return readEnvironmentFromLoginShell(shell, ["PATH"], execFile).PATH;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = execFileSync,
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
  execFile = execFileSync,
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
      : (maybeExecFile ?? (execFileSync as ExecFileSyncLike));
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

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
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

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some((candidate) =>
      isExecutableFile(candidate, platform, windowsPathExtensions),
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(pathDelimiterForPlatform(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (isExecutableFile(join(pathEntry, candidate), platform, windowsPathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

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

export interface WindowsEnvironmentResolverOptions {
  readonly readEnvironment?: WindowsShellEnvironmentReader;
  readonly commandAvailable?: typeof isCommandAvailable;
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

export function resolveWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  options: WindowsEnvironmentResolverOptions = {},
): Partial<NodeJS.ProcessEnv> {
  const readEnvironment = options.readEnvironment ?? readEnvironmentFromWindowsShell;
  const commandAvailable = options.commandAvailable ?? isCommandAvailable;
  const inheritedPath = readEnvPath(env);
  const shellPath = readWindowsEnvironmentSafely(readEnvironment, ["PATH"], {
    loadProfile: false,
  }).PATH;
  const mergedPath = mergePathValues(shellPath, inheritedPath, "win32");
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  const baselinePath = mergePathValues(knownCliPath, mergedPath, "win32");
  const baselinePatch: Partial<NodeJS.ProcessEnv> = baselinePath ? { PATH: baselinePath } : {};
  const baselineEnv = mergeWindowsEnv(env, baselinePatch);

  if (commandAvailable("node", { platform: "win32", env: baselineEnv })) {
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
}
