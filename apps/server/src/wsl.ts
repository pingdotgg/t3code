import { spawnSync } from "node:child_process";

export interface WslWorkspacePath {
  readonly windowsPath: string;
  readonly distribution: string;
  readonly linuxPath: string;
}

export interface WslLaunchConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly workspace: WslWorkspacePath;
}

interface WindowsSpawnCwdOptions {
  readonly platform?: NodeJS.Platform;
  readonly preferredCwd?: string | undefined;
  readonly processCwd?: string | undefined;
  readonly systemRoot?: string | undefined;
  readonly userProfile?: string | undefined;
}

interface WorkspaceLaunchInput {
  readonly workspaceRoot: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform;
  readonly preferredWindowsCwd?: string | undefined;
  readonly processCwd?: string | undefined;
  readonly systemRoot?: string | undefined;
  readonly userProfile?: string | undefined;
}

const WSL_LOCALHOST_PREFIX = "\\\\wsl.localhost\\";
const WSL_DOLLAR_PREFIX = "\\\\wsl$\\";
const WSL_SHELL_LOOKUP_COMMAND =
  'shell="${SHELL:-/bin/sh}"; exec "$shell" -l -i -c \'command -v "$1"\' wsl-shell "$@"';
const WSL_SHELL_EXEC_COMMAND =
  'shell="${SHELL:-/bin/sh}"; exec "$shell" -l -i -c \'exec "$@"\' wsl-shell "$@"';

function normalizeWindowsSeparators(value: string): string {
  return value.replace(/\//g, "\\");
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value);
}

function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

function shouldProbeWslCommandPath(command: string): boolean {
  return (
    command.trim().length > 0 &&
    !isWindowsAbsolutePath(normalizeWindowsSeparators(command)) &&
    !isPosixAbsolutePath(command) &&
    !command.includes("/") &&
    !command.includes("\\")
  );
}

function lastNonEmptyLine(value: string): string | null {
  const lines = value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}

export function parseWslWorkspacePath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
): WslWorkspacePath | null {
  if (platform !== "win32") {
    return null;
  }

  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalized = normalizeWindowsSeparators(trimmed);
  const lower = normalized.toLowerCase();
  const prefix = lower.startsWith(WSL_LOCALHOST_PREFIX)
    ? WSL_LOCALHOST_PREFIX
    : lower.startsWith(WSL_DOLLAR_PREFIX)
      ? WSL_DOLLAR_PREFIX
      : null;
  if (!prefix) {
    return null;
  }

  const tail = normalized.slice(prefix.length);
  const separatorIndex = tail.indexOf("\\");
  const distribution = (separatorIndex === -1 ? tail : tail.slice(0, separatorIndex)).trim();
  if (distribution.length === 0) {
    return null;
  }

  const remainder = separatorIndex === -1 ? "" : tail.slice(separatorIndex + 1);
  const linuxSegments = remainder.split("\\").filter((segment) => segment.length > 0);
  const linuxPath = linuxSegments.length === 0 ? "/" : `/${linuxSegments.join("/")}`;

  return {
    windowsPath: normalized,
    distribution,
    linuxPath,
  };
}

export function toWslPath(
  rawPath: string,
  input?: {
    readonly platform?: NodeJS.Platform;
    readonly distribution?: string;
  },
): string | null {
  const platform = input?.platform ?? process.platform;
  if (platform !== "win32") {
    return null;
  }

  const workspace = parseWslWorkspacePath(rawPath, platform);
  if (workspace) {
    if (
      input?.distribution &&
      workspace.distribution.localeCompare(input.distribution, undefined, {
        sensitivity: "base",
      }) !== 0
    ) {
      return null;
    }
    return workspace.linuxPath;
  }

  const normalized = normalizeWindowsSeparators(rawPath.trim());
  if (!isWindowsAbsolutePath(normalized)) {
    return null;
  }

  const driveLetter = normalized[0]?.toLowerCase();
  const remainder = normalized.slice(3).split("\\").filter((segment) => segment.length > 0);
  return remainder.length === 0
    ? `/mnt/${driveLetter}`
    : `/mnt/${driveLetter}/${remainder.join("/")}`;
}

export function resolveWindowsSpawnCwd(input: WindowsSpawnCwdOptions = {}): string {
  const platform = input.platform ?? process.platform;
  const candidates = [
    input.preferredCwd,
    input.processCwd ?? process.cwd(),
    input.systemRoot ?? process.env.SystemRoot ?? process.env.windir,
    input.userProfile ?? process.env.USERPROFILE,
    "C:\\Windows",
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (platform !== "win32") {
      return trimmed;
    }
    const normalized = normalizeWindowsSeparators(trimmed);
    if (!isWindowsAbsolutePath(normalized)) {
      continue;
    }
    if (parseWslWorkspacePath(normalized, platform)) {
      continue;
    }
    return normalized;
  }

  return "C:\\Windows";
}

function resolveCommandForWsl(command: string, workspace: WslWorkspacePath): string {
  const translatedCommand =
    toWslPath(command, {
      platform: "win32",
      distribution: workspace.distribution,
    }) ?? command;
  if (
    process.platform !== "win32" ||
    !shouldProbeWslCommandPath(translatedCommand)
  ) {
    return translatedCommand;
  }

  const probe = spawnSync(
    "wsl.exe",
    buildWslShellLookupArgs({
      distribution: workspace.distribution,
      linuxCwd: workspace.linuxPath,
      command: translatedCommand,
    }),
    {
      cwd: resolveWindowsSpawnCwd({
        platform: "win32",
      }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  );

  if (probe.status !== 0) {
    return translatedCommand;
  }

  const resolvedCommand = lastNonEmptyLine(probe.stdout);
  if (!resolvedCommand || !isPosixAbsolutePath(resolvedCommand)) {
    return translatedCommand;
  }

  return resolvedCommand;
}

export function buildWslExecArgs(input: {
  readonly distribution?: string;
  readonly linuxCwd?: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return [
    ...(input.distribution ? ["--distribution", input.distribution] : []),
    ...(input.linuxCwd ? ["--cd", input.linuxCwd] : []),
    "--exec",
    input.command,
    ...(input.args ?? []),
  ];
}

function buildWslShellLookupArgs(input: {
  readonly distribution?: string;
  readonly linuxCwd?: string;
  readonly command: string;
}): ReadonlyArray<string> {
  return [
    ...(input.distribution ? ["--distribution", input.distribution] : []),
    ...(input.linuxCwd ? ["--cd", input.linuxCwd] : []),
    "--exec",
    "/bin/sh",
    "-lc",
    WSL_SHELL_LOOKUP_COMMAND,
    "wsl-shell",
    input.command,
  ];
}

export function buildWslShellExecArgs(input: {
  readonly distribution?: string;
  readonly linuxCwd?: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return [
    ...(input.distribution ? ["--distribution", input.distribution] : []),
    ...(input.linuxCwd ? ["--cd", input.linuxCwd] : []),
    "--exec",
    "/bin/sh",
    "-lc",
    WSL_SHELL_EXEC_COMMAND,
    "wsl-shell",
    input.command,
    ...(input.args ?? []),
  ];
}

export function resolveWorkspaceCommandLaunch(input: WorkspaceLaunchInput): WslLaunchConfig | null {
  const platform = input.platform ?? process.platform;
  const workspace = parseWslWorkspacePath(input.workspaceRoot, platform);
  if (!workspace) {
    return null;
  }

  return {
    command: "wsl.exe",
    args: buildWslExecArgs({
      distribution: workspace.distribution,
      linuxCwd: workspace.linuxPath,
      command: resolveCommandForWsl(input.command, workspace),
      ...(input.args ? { args: input.args } : {}),
    }),
    cwd: resolveWindowsSpawnCwd({
      platform,
      preferredCwd: input.preferredWindowsCwd,
      processCwd: input.processCwd,
      systemRoot: input.systemRoot,
      userProfile: input.userProfile,
    }),
    workspace,
  };
}

export function resolveWorkspaceShellLaunch(input: {
  readonly workspaceRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly preferredWindowsCwd?: string | undefined;
  readonly processCwd?: string | undefined;
  readonly systemRoot?: string | undefined;
  readonly userProfile?: string | undefined;
}): WslLaunchConfig | null {
  const platform = input.platform ?? process.platform;
  const workspace = parseWslWorkspacePath(input.workspaceRoot, platform);
  if (!workspace) {
    return null;
  }

  return {
    command: "wsl.exe",
    args: [
      "--distribution",
      workspace.distribution,
      "--cd",
      workspace.linuxPath,
    ],
    cwd: resolveWindowsSpawnCwd({
      platform,
      preferredCwd: input.preferredWindowsCwd,
      processCwd: input.processCwd,
      systemRoot: input.systemRoot,
      userProfile: input.userProfile,
    }),
    workspace,
  };
}
