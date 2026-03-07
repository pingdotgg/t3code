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

function normalizeWindowsSeparators(value: string): string {
  return value.replace(/\//g, "\\");
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value);
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
  return toWslPath(command, {
    platform: "win32",
    distribution: workspace.distribution,
  }) ?? command;
}

export function resolveWorkspaceCommandLaunch(input: WorkspaceLaunchInput): WslLaunchConfig | null {
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
      "--exec",
      resolveCommandForWsl(input.command, workspace),
      ...(input.args ?? []),
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
    args: ["--distribution", workspace.distribution, "--cd", workspace.linuxPath],
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
