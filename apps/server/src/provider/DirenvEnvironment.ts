import type { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

/** Variables to set (string) or unset (null), as `direnv export json` reports them. */
export type DirenvEnvironmentDiff = Readonly<Record<string, string | null>>;

export type DirenvFailureReason = "blocked" | "timeout" | "failed";

export type DirenvLoadResult =
  /** No `.envrc` governs the directory, or direnv is not installed. */
  | { readonly _tag: "None" }
  | {
      readonly _tag: "Loaded";
      /** The full diff over the server's environment, bookkeeping variables included. */
      readonly diff: DirenvEnvironmentDiff;
      /** False when direnv reported `previous` as still current. */
      readonly changed: boolean;
    }
  | {
      readonly _tag: "Failed";
      readonly envrcPath: string;
      readonly reason: DirenvFailureReason;
      readonly message: string;
    };

export type DirenvLoadFailure = Extract<DirenvLoadResult, { readonly _tag: "Failed" }>;

export type DirenvAllowResult =
  | { readonly _tag: "Allowed"; readonly envrcPath: string }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Failed"; readonly message: string };

/**
 * Loads the direnv environment a shell would get in a directory, so provider
 * sessions see the same project tools (Nix dev shells, devenv, mise, ...) a
 * terminal does. Trust stays with direnv: a blocked `.envrc` is reported and
 * only allowed when the user asks for it.
 */
export class DirenvEnvironment extends Context.Service<
  DirenvEnvironment,
  {
    /**
     * Load the environment for `cwd`. With `previous` (a diff this service
     * returned earlier), this is the shell hook's cheap staleness check: direnv
     * compares the files it watches, such as `.envrc`, its allow record and
     * `flake.lock`, and only re-evaluates when one changed.
     */
    readonly load: (
      cwd: string,
      previous?: DirenvEnvironmentDiff,
    ) => Effect.Effect<DirenvLoadResult>;
    /** `direnv allow` the `.envrc` governing `cwd`. */
    readonly allow: (cwd: string) => Effect.Effect<DirenvAllowResult>;
  }
>()("t3/provider/DirenvEnvironment") {}

const DIRENV_FAILURE_MESSAGES: Record<DirenvFailureReason, string> = {
  blocked: "The project's .envrc is blocked, so its direnv environment was not loaded.",
  timeout: "Loading the project's direnv environment timed out.",
  failed: "The project's direnv environment failed to load.",
};

/** What a thread shows for a failed load; a blocked `.envrc` offers to allow it. */
export function direnvFailureNotice(failure: DirenvLoadFailure): {
  readonly message: string;
  readonly detail: string;
  readonly action?: { readonly type: "direnv.allow" };
} {
  return {
    message: DIRENV_FAILURE_MESSAGES[failure.reason],
    detail: failure.message,
    ...(failure.reason === "blocked" ? { action: { type: "direnv.allow" } as const } : {}),
  };
}

// A first `nix develop` evaluation can legitimately take minutes.
const DIRENV_TIMEOUT = "5 minutes";

const decodeDirenvExport = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
);

const ANSI_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

/** The `direnv: error ...` lines, or the last stderr line when there are none. */
export function direnvErrorMessage(stderr: string): string {
  const lines = stderr
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errors = lines.filter((line) => line.startsWith("direnv: error"));
  return (errors.length > 0 ? errors.join("\n") : (lines.at(-1) ?? "direnv failed")).replace(
    /^direnv: (error )?/,
    "",
  );
}

export const make = Effect.fn("DirenvEnvironment.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;

  const findEnvrc = Effect.fn("DirenvEnvironment.findEnvrc")(function* (cwd: string) {
    let directory = path.resolve(cwd);
    while (true) {
      const candidate = path.join(directory, ".envrc");
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
      const parent = path.dirname(directory);
      if (parent === directory) return Option.none<string>();
      directory = parent;
    }
  });

  const loadUncached = Effect.fn("DirenvEnvironment.load")(function* (
    cwd: string,
    previous: DirenvEnvironmentDiff | undefined,
  ) {
    if (platform === "win32") return { _tag: "None" } as const;
    const envrcPath = yield* findEnvrc(cwd);
    // Without a previous load there is nothing for direnv to unload either.
    if (Option.isNone(envrcPath) && previous === undefined) return { _tag: "None" } as const;

    const failed = (reason: DirenvFailureReason, message: string) =>
      ({
        _tag: "Failed",
        envrcPath: Option.getOrElse(envrcPath, () => path.join(cwd, ".envrc")),
        reason,
        message,
      }) as const;
    const result = yield* runner
      .run({
        command: "direnv",
        args: ["export", "json"],
        cwd,
        // direnv diffs against the environment it is given, so a staleness
        // check must see exactly what the previous load produced.
        ...(previous
          ? { env: applyDirenvEnvironment(process.env, previous), extendEnv: false }
          : {}),
        timeout: DIRENV_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      // Having an `.envrc` without direnv installed is common in shared repos.
      return result.failure._tag === "ProcessSpawnError"
        ? ({ _tag: "None" } as const)
        : failed("failed", result.failure.message);
    }
    const output = result.success;
    if (output.timedOut)
      return failed("timeout", `direnv did not finish within ${DIRENV_TIMEOUT}.`);
    if (output.code !== 0) {
      const message = direnvErrorMessage(output.stderr);
      return failed(message.includes(" is blocked") ? "blocked" : "failed", message);
    }
    // Empty output means the environment is already current for this directory.
    if (output.stdout.trim().length === 0) {
      return { _tag: "Loaded", diff: previous ?? {}, changed: false } as const;
    }
    const delta = decodeDirenvExport(output.stdout);
    if (Option.isNone(delta)) {
      return failed("failed", "direnv printed an environment T3 Code could not read.");
    }
    // `delta` is relative to the previous environment; keep the diff relative
    // to the server's own environment.
    return { _tag: "Loaded", diff: { ...previous, ...delta.value }, changed: true } as const;
  });

  // Threads started together in one checkout share a single evaluation.
  const inFlight = new Map<string, Deferred.Deferred<DirenvLoadResult>>();
  const load = (cwd: string, previous?: DirenvEnvironmentDiff) =>
    Effect.suspend(() => {
      // DIRENV_DIFF identifies the environment a staleness check starts from.
      const key = `${path.resolve(cwd)}\0${previous?.DIRENV_DIFF ?? ""}`;
      const existing = inFlight.get(key);
      if (existing) return Deferred.await(existing);
      const deferred = Deferred.makeUnsafe<DirenvLoadResult>();
      inFlight.set(key, deferred);
      return loadUncached(cwd, previous).pipe(
        Deferred.into(deferred),
        Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
        Effect.andThen(Deferred.await(deferred)),
      );
    });

  const allow = Effect.fn("DirenvEnvironment.allow")(function* (cwd: string) {
    const envrcPath = yield* findEnvrc(cwd);
    if (Option.isNone(envrcPath)) return { _tag: "NotFound" } as const;
    const result = yield* runner
      .run({ command: "direnv", args: ["allow", envrcPath.value], cwd })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      return { _tag: "Failed", message: result.failure.message } as const;
    }
    return result.success.code === 0
      ? ({ _tag: "Allowed", envrcPath: envrcPath.value } as const)
      : ({ _tag: "Failed", message: direnvErrorMessage(result.success.stderr) } as const);
  });

  return DirenvEnvironment.of({ load, allow });
});

export const layer = Layer.effect(DirenvEnvironment, make());

/**
 * Apply a direnv diff over a provider's launch environment. Values the
 * provider instance set itself (anything differing from the server's own
 * environment, like `CODEX_HOME` or `CLAUDE_CONFIG_DIR`) are explicit user
 * configuration and win over the project's `.envrc`.
 */
export function applyDirenvEnvironment(
  base: NodeJS.ProcessEnv,
  diff: DirenvEnvironmentDiff | undefined,
  serverEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!diff) return base;
  const next: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(diff)) {
    if (base[name] !== serverEnv[name]) continue;
    if (value === null) delete next[name];
    else next[name] = value;
  }
  return next;
}

// ProviderSessionManagerV2 loads the diff before opening a session; adapters
// read it while building the provider's launch environment.
const diffsByThread = new Map<ThreadId, DirenvEnvironmentDiff>();

export function setThreadDirenvEnvironment(
  threadId: ThreadId,
  diff: DirenvEnvironmentDiff | undefined,
): void {
  if (diff && Object.keys(diff).length > 0) diffsByThread.set(threadId, diff);
  else diffsByThread.delete(threadId);
}

export function readThreadDirenvEnvironment(threadId: ThreadId): DirenvEnvironmentDiff | undefined {
  return diffsByThread.get(threadId);
}

export function clearAllThreadDirenvEnvironments(): void {
  diffsByThread.clear();
}

/** `base` with the thread's direnv environment applied, or `base` untouched. */
export function withThreadDirenvEnvironment(
  base: NodeJS.ProcessEnv,
  threadId: ThreadId,
): NodeJS.ProcessEnv {
  return applyDirenvEnvironment(base, diffsByThread.get(threadId));
}
