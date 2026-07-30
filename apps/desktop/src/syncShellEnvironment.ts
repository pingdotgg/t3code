import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
  readEnvironmentFromLoginShell,
  resolveWindowsEnvironment,
} from "@t3tools/shared/shell";
import type {
  CommandAvailabilityOptions,
  ShellEnvironmentReader,
  WindowsShellEnvironmentReader,
} from "@t3tools/shared/shell";

type WindowsCommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => boolean;

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

function logShellEnvironmentWarning(message: string, error?: unknown): void {
  console.warn(`[desktop] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readWindowsEnvironment?: WindowsShellEnvironmentReader;
    isWindowsCommandAvailable?: WindowsCommandAvailabilityChecker;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;

  const logWarning = options.logWarning ?? logShellEnvironmentWarning;
  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
  const shellEnvironment: Partial<Record<string, string>> = {};

  try {
    if (platform === "win32") {
      const repairedEnvironment = resolveWindowsEnvironment(env, {
        ...(options.readWindowsEnvironment
          ? { readEnvironment: options.readWindowsEnvironment }
          : {}),
        ...(options.isWindowsCommandAvailable
          ? { commandAvailable: options.isWindowsCommandAvailable }
          : {}),
      });
      for (const [key, value] of Object.entries(repairedEnvironment)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      return;
    }

    if (platform !== "darwin" && platform !== "linux") return;

    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        Object.assign(shellEnvironment, readEnvironment(shell, LOGIN_SHELL_ENV_NAMES));
        if (shellEnvironment.PATH) {
          break;
        }
      } catch (error) {
        logWarning(`Failed to read login shell environment from ${shell}.`, error);
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellEnvironment.PATH
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellEnvironment.PATH ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    for (const name of [
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ] as const) {
      if (!env[name] && shellEnvironment[name]) {
        env[name] = shellEnvironment[name];
      }
    }
  } catch (error) {
    logWarning("Failed to synchronize the desktop shell environment.", error);
  }
}
