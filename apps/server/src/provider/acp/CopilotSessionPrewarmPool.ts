/**
 * CopilotSessionPrewarmPool - holds one Copilot ACP process warmed through the
 * thread-independent part of startup.
 *
 * Copilot session startup is roughly `spawn` + `initialize` + `authenticate` +
 * `session/new`. Only `session/new` is thread-bound: it carries the per-thread
 * MCP credential issued by `McpSessionRegistry`. The prefix costs ~650ms and
 * depends on nothing but the spawn identity, so it can run before the user
 * commits to a thread.
 *
 * The pool therefore warms a process up to `authenticate` and stops. Adoption
 * supplies the thread-bound MCP servers at `session/new` time, so a prewarmed
 * process can never carry another thread's credential.
 *
 * A single slot bounds the cost to at most one idle agent process. Warming is
 * speculative, so it never blocks acquisition: the in-flight build runs outside
 * the pool lock and is bounded by a timeout, meaning a stalled or hung warmup
 * degrades to an ordinary cold session start rather than wedging it.
 *
 * @module CopilotSessionPrewarmPool
 */
import { Duration, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
  AcpSessionRuntime,
} from "./AcpSessionRuntime.ts";

/** Warmed processes older than this are discarded rather than adopted. */
export const COPILOT_PREWARM_TTL_MS = 10 * 60 * 1000;

/**
 * A warmup that has not reached `authenticate` by now is abandoned and its
 * process killed. `initialize` + `authenticate` normally cost ~650ms; ACP
 * requests carry no timeout of their own, so without this a hung agent would
 * hold a process forever.
 */
export const COPILOT_PREWARM_WARMUP_TIMEOUT_MS = 30 * 1000;

export interface CopilotPrewarmRequest {
  readonly spawn: AcpSpawnInput;
  readonly runtimeOptions: Omit<
    Parameters<typeof AcpSessionRuntime.layer>[0],
    "spawn" | "mcpServers"
  >;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

/**
 * Produces a runtime warmed through `authenticate`, owned by the ambient scope.
 * Injectable so the pool's slot, TTL, liveness and scope-transfer behaviour can
 * be tested without a live ACP peer.
 */
export type CopilotPrewarmRuntimeBuilder = (
  request: CopilotPrewarmRequest,
) => Effect.Effect<AcpSessionRuntimeShape, unknown, Scope.Scope>;

export const buildPrewarmedCopilotRuntime: CopilotPrewarmRuntimeBuilder = (request) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({ ...request.runtimeOptions, spawn: request.spawn }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, request.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
    yield* runtime.warmup;
    return runtime;
  });

export interface CopilotPrewarmPoolShape {
  /**
   * Warms a process for `request` unless a live entry with the same spawn
   * identity is already waiting. Never fails: prewarming is best effort.
   */
  readonly prewarm: (request: CopilotPrewarmRequest) => Effect.Effect<void>;
  /**
   * Takes the warmed runtime matching `spawn`, transferring responsibility for
   * closing it to the caller's scope. Returns `undefined` when nothing matches,
   * the entry expired, or its process died.
   */
  readonly acquire: (
    spawn: AcpSpawnInput,
  ) => Effect.Effect<AcpSessionRuntimeShape | undefined, never, Scope.Scope>;
}

/**
 * Spawn identity of a warmed process. Two requests can share a process only
 * when every input that shapes the spawn matches — the binary, the ACP/runtime
 * mode arguments, the working directory, and the custom instruction dirs.
 */
export function copilotPrewarmKey(spawn: AcpSpawnInput): string {
  return JSON.stringify([
    spawn.command,
    [...spawn.args],
    spawn.cwd ?? "",
    Object.entries(spawn.env ?? {})
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

interface PrewarmEntry {
  readonly key: string;
  readonly runtime: AcpSessionRuntimeShape;
  readonly scope: Scope.Closeable;
  readonly warmedAt: number;
}

interface PoolState {
  readonly entry: PrewarmEntry | undefined;
  /** Spawn key of a build running outside the lock, if any. */
  readonly warmingKey: string | undefined;
  readonly closed: boolean;
}

const closeEntry = (entry: PrewarmEntry) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

export const makeCopilotSessionPrewarmPool = (
  buildRuntime: CopilotPrewarmRuntimeBuilder = buildPrewarmedCopilotRuntime,
) =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<PoolState>({
      entry: undefined,
      warmingKey: undefined,
      closed: false,
    });

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(state, (current) =>
        Effect.gen(function* () {
          if (current.entry) {
            yield* closeEntry(current.entry);
          }
          return { entry: undefined, warmingKey: current.warmingKey, closed: true };
        }),
      ),
    );

    const buildEntry = (request: CopilotPrewarmRequest, key: string) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const runtime = yield* buildRuntime(request).pipe(
          Effect.timeout(Duration.millis(COPILOT_PREWARM_WARMUP_TIMEOUT_MS)),
          Effect.provideService(Scope.Scope, scope),
          // A failed, timed-out or interrupted warmup must not leak the process.
          Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
        );

        return {
          key,
          runtime,
          scope,
          warmedAt: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
        } satisfies PrewarmEntry;
      });

    const isUsable = (entry: PrewarmEntry, key: string, now: number) =>
      entry.key === key && now - entry.warmedAt < COPILOT_PREWARM_TTL_MS
        ? entry.runtime.isProcessAlive
        : Effect.succeed(false);

    const prewarm: CopilotPrewarmPoolShape["prewarm"] = (request) =>
      Effect.gen(function* () {
        const key = copilotPrewarmKey(request.spawn);
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

        // Claim the slot in a critical section that only does bookkeeping, so
        // `acquire` never waits on a network round trip.
        const claimed = yield* SynchronizedRef.modifyEffect(state, (current) =>
          Effect.gen(function* () {
            if (current.closed || current.warmingKey !== undefined) {
              return [false, current] as const;
            }
            if (current.entry && (yield* isUsable(current.entry, key, now))) {
              return [false, current] as const;
            }
            return [true, { ...current, warmingKey: key }] as const;
          }),
        );
        if (!claimed) {
          return;
        }

        const entry = yield* buildEntry(request, key).pipe(
          Effect.tapError((error) =>
            Effect.logDebug("copilot prewarm failed", { key, error: String(error) }),
          ),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );

        yield* SynchronizedRef.updateEffect(state, (current) =>
          Effect.gen(function* () {
            const released = { ...current, warmingKey: undefined };
            if (!entry) {
              return released;
            }
            // The pool shut down while this was building: do not resurrect it.
            if (current.closed) {
              yield* closeEntry(entry);
              return released;
            }
            if (current.entry) {
              yield* closeEntry(current.entry);
            }
            return { ...released, entry };
          }),
        );
      }).pipe(Effect.ignore);

    const acquire: CopilotPrewarmPoolShape["acquire"] = (spawn) =>
      Effect.gen(function* () {
        const key = copilotPrewarmKey(spawn);
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

        const taken = yield* SynchronizedRef.modifyEffect(state, (current) =>
          Effect.gen(function* () {
            if (!current.entry) {
              return [undefined, current] as const;
            }
            if (!(yield* isUsable(current.entry, key, now))) {
              yield* closeEntry(current.entry);
              return [undefined, { ...current, entry: undefined }] as const;
            }
            return [current.entry, { ...current, entry: undefined }] as const;
          }),
        );

        if (!taken) {
          return undefined;
        }

        // The caller now owns the process: tie it to the session scope so a
        // failed or finished session tears the process down exactly once.
        yield* Effect.addFinalizer(() => closeEntry(taken));
        return taken.runtime;
      });

    return { prewarm, acquire } satisfies CopilotPrewarmPoolShape;
  });
