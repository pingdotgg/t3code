import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  type ShellEnvironmentReader,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = readPathFromLoginShell(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
}

const POSIX_PROVIDER_AUTH_ENV_NAMES = ["SAKANA_API_KEY"] as const;

export function hydratePosixProviderAuthEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: {
    readonly readEnvironment?: ShellEnvironmentReader;
    readonly shellCandidates?: ReadonlyArray<string>;
  } = {},
): void {
  if (platform !== "darwin" && platform !== "linux") return;

  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
  const shellCandidates = options.shellCandidates ?? listLoginShellCandidates(platform, env.SHELL);
  let missingNames = POSIX_PROVIDER_AUTH_ENV_NAMES.filter((name) => !env[name]);
  if (missingNames.length === 0) return;

  for (const shell of shellCandidates) {
    let shellEnvironment: Partial<Record<string, string>>;
    try {
      shellEnvironment = readEnvironment(shell, missingNames);
    } catch (error) {
      logPathHydrationWarning(
        `Failed to read provider environment from login shell ${shell}.`,
        error,
      );
      continue;
    }

    for (const name of missingNames) {
      const value = shellEnvironment[name];
      if (value && value.length > 0) {
        env[name] = value;
      }
    }

    missingNames = missingNames.filter((name) => !env[name]);
    if (missingNames.length === 0) return;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (): Effect.fn.Return<
  void,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );

  yield* Effect.sync(() => hydratePosixProviderAuthEnvironment(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning(
          "Failed to hydrate provider auth environment from the user environment.",
          defect,
        );
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".t3");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
