import * as OS from "node:os";
import { Effect, Path } from "effect";
import {
  readPathFromLoginShell,
  readEnvironmentFromWindowsShell,
  resolveWindowsEnvironment,
  type CommandAvailabilityOptions,
  type WindowsShellEnvironmentReader,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
} from "@t3tools/shared/shell";

type WindowsCommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => boolean;

function logPathHydrationWarning(message: string, error?: unknown): void {
  console.warn(`[server] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
    readWindowsEnvironment?: WindowsShellEnvironmentReader;
    isWindowsCommandAvailable?: WindowsCommandAvailabilityChecker;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const logWarning = options.logWarning ?? logPathHydrationWarning;
  const readPath = options.readPath ?? readPathFromLoginShell;

  try {
    if (platform === "win32") {
      const repairedEnvironment = resolveWindowsEnvironment(env, {
        readEnvironment: options.readWindowsEnvironment ?? readEnvironmentFromWindowsShell,
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

    let shellPath: string | undefined;
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      try {
        shellPath = readPath(shell);
      } catch (error) {
        logWarning(`Failed to read PATH from login shell ${shell}.`, error);
      }

      if (shellPath) {
        break;
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellPath
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }
  } catch (error) {
    logWarning("Failed to hydrate PATH from the user environment.", error);
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(OS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(OS.homedir(), ".t3");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
