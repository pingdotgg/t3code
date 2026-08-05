import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsBaselineEnvironment,
  resolveWindowsEnvironment,
  resolveWindowsProfileEnvironment,
} from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
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

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const HostEnvironmentHydration = Context.Reference<{
  readonly windowsProfile: Option.Option<Effect.Effect<void>>;
}>("t3/os-jank/HostEnvironmentHydration", {
  defaultValue: () => ({ windowsProfile: Option.none() }),
});

function applyEnvironmentPatch(env: NodeJS.ProcessEnv, patch: Partial<NodeJS.ProcessEnv>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) env[key] = value;
  }
}

export const hostEnvironmentHydrationLayer = Layer.effect(
  HostEnvironmentHydration,
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const env = yield* HostProcessEnvironment;
    if (platform !== "win32") {
      yield* fixPath();
      return { windowsProfile: Option.none() };
    }

    yield* Effect.sync(() => applyEnvironmentPatch(env, resolveWindowsBaselineEnvironment(env)));
    const completed = yield* Deferred.make<void>();
    yield* resolveWindowsProfileEnvironment(env).pipe(
      Effect.tap((patch) => Effect.sync(() => applyEnvironmentPatch(env, patch))),
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          logPathHydrationWarning("Failed to hydrate PATH from the PowerShell profile.", cause),
        ),
      ),
      Effect.ensuring(Deferred.succeed(completed, undefined)),
      Effect.forkScoped,
    );

    return {
      windowsProfile: Option.some(Deferred.await(completed)),
    };
  }),
);

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
