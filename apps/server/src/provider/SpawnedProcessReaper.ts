// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";

const MAX_RESPAWN_ATTEMPTS = 3;
const RESPAWN_WINDOW_MS = 60_000;
const SIDECAR_RETRY_DELAY = "100 millis";

export type SpawnedProcessReaperPlatform = "posix" | "win32";

export interface SpawnedProcessReaperEntry {
  readonly pid: number;
  readonly pgid: number | null;
  readonly platform: SpawnedProcessReaperPlatform;
}

export class SpawnedProcessReaperError extends Schema.TaggedErrorClass<SpawnedProcessReaperError>()(
  "SpawnedProcessReaperError",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals(["close", "spawn", "write"]),
  },
) {
  override get message(): string {
    return `Spawned process reaper sidecar ${this.operation} failed.`;
  }
}

export class SpawnedProcessReaper extends Context.Service<
  SpawnedProcessReaper,
  {
    readonly track: (input: SpawnedProcessReaperEntry) => Effect.Effect<void>;
    readonly untrack: (pid: number) => Effect.Effect<void>;
  }
>()("t3/provider/SpawnedProcessReaper") {}

export const SIDECAR_SOURCE = String.raw`
"use strict";
const { spawnSync } = require("node:child_process");
const entries = new Map();
let shuttingDown = false;
let parentDeathHandled = false;
const parentPid = process.ppid;

const killPosix = (entry, signal) => {
  if (entry.pgid === null) {
    try {
      process.kill(entry.pid, signal);
    } catch {}
    return;
  }
  try {
    process.kill(-entry.pgid, signal);
  } catch {
    try {
      process.kill(entry.pid, signal);
    } catch {}
  }
};

const killWindows = (entry) => {
  try {
    spawnSync("taskkill", ["/PID", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
};

const reapAfterParentDeath = () => {
  if (parentDeathHandled || shuttingDown) return;
  parentDeathHandled = true;
  const snapshot = [...entries.values()];
  let hasPosixEntry = false;
  for (const entry of snapshot) {
    if (entry.platform === "win32") {
      killWindows(entry);
    } else {
      hasPosixEntry = true;
      killPosix(entry, "SIGTERM");
    }
  }
  if (!hasPosixEntry) {
    process.exit(0);
  }
  setTimeout(() => {
    for (const entry of snapshot) {
      if (entry.platform === "posix") killPosix(entry, "SIGKILL");
    }
    process.exit(0);
  }, 500);
};

const isParentDead = () => {
  if (process.ppid !== parentPid) return true;
  try {
    process.kill(parentPid, 0);
    return false;
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ESRCH";
  }
};

let parentDeathCheckStarted = false;
const checkParentDeath = () => {
  if (parentDeathHandled || shuttingDown) return;
  if (isParentDead()) {
    reapAfterParentDeath();
    return;
  }
  setTimeout(checkParentDeath, 1000);
};

const handleLine = (line) => {
  if (line.length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== "object") return;
  if (message.op === "shutdown") {
    shuttingDown = true;
    process.exit(0);
  }
  const hasValidPgid =
    message.pgid === undefined || message.pgid === null || Number.isFinite(message.pgid);
  if (message.op === "track" && Number.isFinite(message.pid) && hasValidPgid) {
    entries.set(message.pid, {
      pid: message.pid,
      pgid: message.pgid === undefined || message.pgid === null ? null : message.pgid,
      platform: message.platform === "win32" ? "win32" : "posix",
    });
  } else if (message.op === "untrack" && Number.isFinite(message.pid)) {
    entries.delete(message.pid);
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    handleLine(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
  }
});
const handleStdinTermination = () => {
  if (parentDeathCheckStarted || parentDeathHandled || shuttingDown) return;
  parentDeathCheckStarted = true;
  if (buffer.length > 0) {
    const trailing = buffer;
    buffer = "";
    handleLine(trailing);
  }
  if (!shuttingDown) checkParentDeath();
};

// EOF without shutdown starts a parent-liveness check instead of assuming a broken pipe is fatal.
process.stdin.on("end", handleStdinTermination);
process.stdin.on("error", () => process.exit(1));
`;

export const windowsTaskkillArgs = (pid: number): [string, string, string, string] => [
  "/PID",
  String(pid),
  "/T",
  "/F",
];

export interface SpawnedProcessReaperStdin {
  readonly write: (chunk: string) => boolean;
  readonly end: () => void;
}

export interface SpawnedProcessReaperSidecar {
  readonly stdin: SpawnedProcessReaperStdin;
  readonly exitCode: Effect.Effect<number | null>;
  readonly terminate: Effect.Effect<void>;
}

export interface SpawnedProcessReaperSpawner {
  readonly spawn: () => Effect.Effect<SpawnedProcessReaperSidecar, SpawnedProcessReaperError>;
}

const makeNodeSidecarSpawner = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): SpawnedProcessReaperSpawner => ({
  spawn: () =>
    Effect.try({
      try: () => {
        const child = NodeChildProcess.spawn(process.execPath, ["-e", SIDECAR_SOURCE], {
          // Electron must launch the sidecar in Node mode so its stdin protocol works.
          env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
          detached: platform !== "win32",
          windowsHide: platform === "win32",
          stdio: ["pipe", "ignore", "ignore"],
        });
        const stdin = child.stdin;
        if (stdin === null) {
          child.kill();
          throw new Error("Spawned process reaper sidecar did not expose stdin");
        }

        const exitDeferred = Deferred.makeUnsafe<number | null>();
        const completeExit = (code: number | null) => {
          Deferred.doneUnsafe(exitDeferred, Effect.succeed(code));
        };
        child.once("exit", (code) => completeExit(code));
        child.once("error", () => completeExit(null));
        child.on("error", () => undefined);
        stdin.on("error", () => undefined);
        child.unref();

        return {
          stdin: {
            write: (chunk) => stdin.write(chunk),
            end: () => stdin.end(),
          },
          exitCode: Deferred.await(exitDeferred),
          terminate: Effect.sync(() => {
            try {
              child.kill();
            } catch {
              // The sidecar may already have exited.
            }
          }),
        } satisfies SpawnedProcessReaperSidecar;
      },
      catch: (cause) => new SpawnedProcessReaperError({ operation: "spawn", cause }),
    }),
});

export const makeSpawnedProcessReaper = Effect.fn("SpawnedProcessReaper.make")(function* (
  spawner: SpawnedProcessReaperSpawner,
): Effect.fn.Return<SpawnedProcessReaper["Service"], never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const tracked = new Map<number, SpawnedProcessReaperEntry>();
  let sidecar: SpawnedProcessReaperSidecar | null = null;
  let shuttingDown = false;
  let respawnAttempts = 0;
  let spawnRetryAttempts = 0;
  let retryFiber: Fiber.Fiber<void, never> | null = null;
  const sidecarSpawnTimes = new WeakMap<SpawnedProcessReaperSidecar, number>();

  const logFailure = (operation: "close" | "spawn" | "write", _cause: unknown) =>
    Effect.logWarning("Spawned process reaper sidecar operation failed.", { operation });

  const writeMessage = (
    candidate: SpawnedProcessReaperSidecar,
    message: object,
  ): Effect.Effect<boolean> =>
    Effect.try({
      try: () => {
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        candidate.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      },
      catch: (cause) => new SpawnedProcessReaperError({ operation: "write", cause }),
    }).pipe(Effect.catch((cause) => logFailure("write", cause).pipe(Effect.as(false))));

  const closeStdin = (candidate: SpawnedProcessReaperSidecar): Effect.Effect<void> =>
    Effect.try({
      try: () => candidate.stdin.end(),
      catch: (cause) => new SpawnedProcessReaperError({ operation: "close", cause }),
    }).pipe(
      Effect.catch((cause) => logFailure("close", cause)),
      Effect.asVoid,
    );

  const trySpawnSidecar = Effect.fn("SpawnedProcessReaper.trySpawnSidecar")(function* () {
    const candidate = yield* spawner
      .spawn()
      .pipe(Effect.catch((cause) => logFailure("spawn", cause).pipe(Effect.as(null))));
    if (candidate === null) return null;
    sidecarSpawnTimes.set(candidate, yield* Clock.currentTimeMillis);
    return candidate;
  });

  let ensureSidecar: () => Effect.Effect<void>;

  const scheduleRetry = Effect.fn("SpawnedProcessReaper.scheduleRetry")(function* (
    delay: number | typeof SIDECAR_RETRY_DELAY,
    resetSpawnBudget: boolean,
  ) {
    if (retryFiber !== null || shuttingDown || tracked.size === 0) {
      return;
    }
    retryFiber = yield* Effect.sleep(delay).pipe(
      Effect.andThen(
        mutex.withPermit(
          Effect.gen(function* () {
            retryFiber = null;
            if (resetSpawnBudget) spawnRetryAttempts = 0;
            yield* ensureSidecar();
          }),
        ),
      ),
      Effect.forkIn(scope),
    );
  });

  const handleSidecarFailure = Effect.fn("SpawnedProcessReaper.handleSidecarFailure")(function* (
    candidate: SpawnedProcessReaperSidecar,
  ) {
    if (sidecar !== candidate) return;
    sidecar = null;
    yield* candidate.terminate;
    if (shuttingDown || tracked.size === 0) return;
    const spawnedAt = sidecarSpawnTimes.get(candidate);
    if (
      spawnedAt !== undefined &&
      (yield* Clock.currentTimeMillis) - spawnedAt > RESPAWN_WINDOW_MS
    ) {
      // A sidecar that lived past the window starts a fresh crash-loop budget.
      respawnAttempts = 0;
    }
    respawnAttempts += 1;
    if (respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
      yield* Effect.logWarning(
        `Spawned process reaper sidecar failed three times within ${RESPAWN_WINDOW_MS}ms; giving up`,
      );
      return;
    }
    yield* ensureSidecar();
  });

  const watchSidecar = (candidate: SpawnedProcessReaperSidecar): Effect.Effect<void> =>
    candidate.exitCode.pipe(
      Effect.flatMap(() =>
        mutex.withPermit(
          Effect.gen(function* () {
            if (sidecar !== candidate) return;
            yield* handleSidecarFailure(candidate);
          }),
        ),
      ),
    );

  const feedSidecar = Effect.fn("SpawnedProcessReaper.feedSidecar")(function* (
    candidate: SpawnedProcessReaperSidecar,
  ) {
    for (const entry of tracked.values()) {
      if (!(yield* writeMessage(candidate, { op: "track", ...entry }))) {
        yield* handleSidecarFailure(candidate);
        return;
      }
    }
    yield* watchSidecar(candidate).pipe(Effect.forkIn(scope), Effect.asVoid);
  });

  ensureSidecar = Effect.fn("SpawnedProcessReaper.ensureSidecar")(function* () {
    if (
      sidecar !== null ||
      shuttingDown ||
      tracked.size === 0 ||
      respawnAttempts >= MAX_RESPAWN_ATTEMPTS ||
      spawnRetryAttempts >= MAX_RESPAWN_ATTEMPTS
    ) {
      return;
    }
    const candidate = yield* trySpawnSidecar();
    if (candidate === null) {
      spawnRetryAttempts += 1;
      if (spawnRetryAttempts >= MAX_RESPAWN_ATTEMPTS) {
        yield* Effect.logWarning(
          `Spawned process reaper sidecar failed three times within ${RESPAWN_WINDOW_MS}ms; pausing retries`,
        );
        yield* scheduleRetry(RESPAWN_WINDOW_MS, true);
        return;
      }
      yield* scheduleRetry(SIDECAR_RETRY_DELAY, false);
      return;
    }
    if (shuttingDown) return;
    spawnRetryAttempts = 0;
    sidecar = candidate;
    yield* feedSidecar(candidate);
  });

  const track = Effect.fn("SpawnedProcessReaper.track")(function* (
    entry: SpawnedProcessReaperEntry,
  ) {
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (shuttingDown) return;
        tracked.set(entry.pid, entry);
        const existingSidecar = sidecar;
        yield* ensureSidecar();
        if (existingSidecar !== null && sidecar === existingSidecar) {
          if (!(yield* writeMessage(existingSidecar, { op: "track", ...entry }))) {
            yield* handleSidecarFailure(existingSidecar);
          }
        }
      }),
    );
  });

  const untrack = Effect.fn("SpawnedProcessReaper.untrack")(function* (pid: number) {
    yield* mutex.withPermit(
      Effect.gen(function* () {
        tracked.delete(pid);
        if (tracked.size === 0) {
          respawnAttempts = 0;
          spawnRetryAttempts = 0;
        }
        const candidate = sidecar;
        if (candidate !== null && !(yield* writeMessage(candidate, { op: "untrack", pid }))) {
          yield* handleSidecarFailure(candidate);
        }
      }),
    );
  });

  const shutdown = mutex.withPermit(
    Effect.gen(function* () {
      shuttingDown = true;
      const candidate = sidecar;
      sidecar = null;
      if (candidate !== null) {
        const sent = yield* writeMessage(candidate, { op: "shutdown" });
        if (!sent) {
          yield* candidate.terminate;
          return;
        }
        yield* closeStdin(candidate);
      }
    }),
  );

  yield* Effect.addFinalizer(() => shutdown);

  return { track, untrack } satisfies SpawnedProcessReaper["Service"];
});

const makeSpawnedProcessReaperLive = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  return yield* makeSpawnedProcessReaper(makeNodeSidecarSpawner(platform, environment));
});

export const layer = Layer.effect(SpawnedProcessReaper, makeSpawnedProcessReaperLive);
