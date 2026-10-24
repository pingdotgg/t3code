import {
  resolveNodeExecutable,
  type NodeRuntimeUnavailableError,
} from "@t3tools/shared/nodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";

// Synchronous deletion in one child keeps both recursive fan-out and blocked
// Windows deletes off the request-serving process's libuv pool.
const REMOVE_SCRIPT =
  'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });';
const MAX_PENDING_DIRECTORIES = 8;
export const BACKLOG_FULL_MESSAGE =
  "Antigravity is still removing temporary runtime files. Wait for cleanup to finish, then try again.";

export class BacklogFullError extends Schema.TaggedError<BacklogFullError>()(
  "AntigravityRuntimeTempBacklogFullError",
  {},
) {
  override get message() {
    return BACKLOG_FULL_MESSAGE;
  }
}

export class AntigravityRuntimeTemp extends Context.Service<
  AntigravityRuntimeTemp,
  {
    readonly makeDirectory: Effect.Effect<
      string,
      PlatformError.PlatformError | BacklogFullError | NodeRuntimeUnavailableError,
      Scope.Scope
    >;
    readonly adopt: (directory: string) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/provider/AntigravityRuntimeTemp") {}

export const make = Effect.fn("AntigravityRuntimeTemp.make")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const active = new Set<string>();
  const allocation = yield* Semaphore.make(1);
  const deletion = yield* Semaphore.make(1);
  // The directories are the durable queue. Only wake-ups are coalesced in memory.
  const wake = yield* Queue.dropping<void>(1);
  const notify = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const resolveNode = resolveNodeExecutable("Antigravity").pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
  // A standalone provider can supply Node through its own PATH or version manager.
  let cleanupRuntime:
    | { readonly node: string; readonly environment: NodeJS.ProcessEnv }
    | undefined;

  const drain = Effect.gen(function* () {
    const pending = yield* allocation.withPermit(
      fs.readDirectory(directory).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => entry.startsWith("run-"))
            .map((entry) => path.join(directory, entry))
            .filter((entry) => !active.has(entry)),
        ),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed([]),
        ),
      ),
    );
    if (pending.length === 0) return;
    const runtime = cleanupRuntime ?? {
      node: yield* resolveNode,
      environment: yield* HostProcess.Environment,
    };
    for (const entry of pending) {
      yield* Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(runtime.node, ["--eval", REMOVE_SCRIPT, entry], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            env: { ...runtime.environment, ELECTRON_RUN_AS_NODE: "1" },
            extendEnv: false,
          }),
        );
        const code = yield* child.exitCode;
        if (code !== 0) {
          yield* Effect.logWarning("Antigravity temp cleanup failed; it will be retried.", {
            exitCode: code,
          });
        }
      }).pipe(
        Effect.scoped,
        Effect.catch(() =>
          Effect.logWarning("Could not start Antigravity temp cleanup; it will be retried."),
        ),
      );
    }
  }).pipe(
    deletion.withPermit,
    Effect.catch(() =>
      Effect.logWarning("Could not sweep Antigravity temp directories; it will be retried."),
    ),
  );

  const makeDirectory = Effect.gen(function* () {
    cleanupRuntime = { node: yield* resolveNode, environment: yield* HostProcess.Environment };
    yield* notify;
    return yield* Effect.acquireRelease(
      allocation.withPermit(
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true });
          const pending = (yield* fs.readDirectory(directory)).filter(
            (entry) => entry.startsWith("run-") && !active.has(path.join(directory, entry)),
          );
          if (pending.length >= MAX_PENDING_DIRECTORIES) return yield* new BacklogFullError();
          const created = yield* fs.makeTempDirectory({ directory, prefix: "run-" });
          active.add(created);
          return created;
        }),
      ),
      (created) => Effect.sync(() => active.delete(created)).pipe(Effect.andThen(notify)),
    );
  });

  const adopt = Effect.fn("AntigravityRuntimeTemp.adopt")(
    function* (previous: string) {
      yield* allocation.withPermit(
        Effect.gen(function* () {
          if (!(yield* fs.exists(previous))) return;
          yield* fs.makeDirectory(directory, { recursive: true });
          const id = yield* crypto.randomUUIDv4();
          yield* fs.rename(previous, path.join(directory, `run-${id}`));
        }),
      );
      yield* notify;
    },
    Effect.catch(() =>
      Effect.logWarning(
        "Could not move leftover Antigravity temp files; the next start will retry.",
      ),
    ),
  );

  yield* Effect.forever(
    drain.pipe(Effect.andThen(Queue.take(wake).pipe(Effect.timeoutOption("1 minute")))),
  ).pipe(Effect.forkScoped);

  return AntigravityRuntimeTemp.of({ makeDirectory, adopt, drain });
});

export const layer = Layer.effect(
  AntigravityRuntimeTemp,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    // Keep PyInstaller extraction paths below Windows' MAX_PATH.
    return yield* make(path.join(config.stateDir, "antigravity-gc"));
  }),
);
