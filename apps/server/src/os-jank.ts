import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
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

const POSIX_PROVIDER_AUTH_ENV_NAMES = ["SAKANA_API_KEY"] as const;
type PosixProviderAuthEnvName = (typeof POSIX_PROVIDER_AUTH_ENV_NAMES)[number];

export function hydratePosixProviderAuthEnvironment(
  env: NodeJS.ProcessEnv,
  shellEnvironment: Partial<Record<PosixProviderAuthEnvName, string>>,
): void {
  for (const name of POSIX_PROVIDER_AUTH_ENV_NAMES) {
    if (env[name]) continue;
    const value = shellEnvironment[name];
    if (value && value.length > 0) {
      env[name] = value;
    }
  }
}

export function hydratePosixProcessEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: {
    readonly readEnvironment?: ShellEnvironmentReader;
    readonly readLaunchctlPath?: () => string | undefined;
    readonly shellCandidates?: ReadonlyArray<string>;
  } = {},
): void {
  if (platform !== "darwin" && platform !== "linux") return;

  const readEnvironment = options.readEnvironment ?? readEnvironmentFromLoginShell;
  const shellCandidates = options.shellCandidates ?? listLoginShellCandidates(platform, env.SHELL);
  let shellPath: string | undefined;
  let missingAuthNames = POSIX_PROVIDER_AUTH_ENV_NAMES.filter((name) => !env[name]);

  for (const shell of shellCandidates) {
    const names = [...(shellPath ? [] : ["PATH"]), ...missingAuthNames];
    if (names.length === 0) break;

    let shellEnvironment: Partial<Record<string, string>>;
    try {
      shellEnvironment = readEnvironment(shell, names);
    } catch (error) {
      logPathHydrationWarning(`Failed to read user environment from login shell ${shell}.`, error);
      continue;
    }

    if (!shellPath && shellEnvironment.PATH) {
      shellPath = shellEnvironment.PATH;
    }
    hydratePosixProviderAuthEnvironment(env, shellEnvironment);
    missingAuthNames = missingAuthNames.filter((name) => !env[name]);
  }

  const readLaunchctlPath = options.readLaunchctlPath ?? readPathFromLaunchctl;
  const launchctlPath = platform === "darwin" && !shellPath ? readLaunchctlPath() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
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

  yield* Effect.sync(() => hydratePosixProcessEnvironment(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate the user environment.", defect);
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
