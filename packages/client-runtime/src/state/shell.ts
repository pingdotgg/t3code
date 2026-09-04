import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import {
  type DynamicSubscriptionGeneration,
  type DynamicSubscriptionItem,
  subscribeDynamicWithGeneration,
} from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
}

const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cachedSnapshot = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<OrchestrationShellSnapshot>()),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
    error: Option.none(),
  });
  const awaitingCompletion = yield* Ref.make(false);
  const lastAuthoritativeSession = yield* Ref.make<RpcSession | null>(null);
  const activeSubscriptionSession = yield* Ref.make<RpcSession | null>(null);
  const activeSubscriptionGeneration = yield* Ref.make<DynamicSubscriptionGeneration | null>(null);
  const persistence = yield* Queue.sliding<OrchestrationShellSnapshot>(1);
  // Serializes batch folds against the subscription's HTTP seed: the fold is
  // a read-modify-write over the snapshot, and one interleaving with the seed
  // would write the fold's older baseline over the seeded snapshot after
  // afterSequence was already computed from it, silently losing the gap.
  const applyLock = yield* Semaphore.make(1);

  const persist = Effect.fn("EnvironmentShellState.persist")(function* (
    snapshot: OrchestrationShellSnapshot,
  ) {
    yield* cache.saveShell(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist environment shell cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setDisconnected = Ref.set(awaitingCompletion, false).pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: shellStatusForSnapshot(current.snapshot),
      })),
    ),
  );
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(Effect.logWarning("Could not synchronize the environment shell.")),
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Folds a run of consecutive snapshot/event items into at most one
  // published state, so a busy environment costs one React commit per batch
  // instead of one per shell event.
  const applyItemRun = Effect.fn("EnvironmentShellState.applyItemRun")(function* (
    run: ReadonlyArray<Exclude<OrchestrationShellStreamItem, { kind: "synchronized" }>>,
  ) {
    const current = yield* SubscriptionRef.get(state);
    let nextSnapshot = Option.getOrNull(current.snapshot);
    let receivedSnapshot = false;
    let applied = false;
    for (const item of run) {
      if (item.kind === "snapshot") {
        nextSnapshot = item.snapshot;
        receivedSnapshot = true;
        applied = true;
      } else if (nextSnapshot !== null) {
        if (item.sequence > nextSnapshot.snapshotSequence) {
          nextSnapshot = applyShellStreamEvent(nextSnapshot, item);
        }
        applied = true;
      }
    }
    if (!applied || nextSnapshot === null) {
      return;
    }

    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.set(state, {
      snapshot: Option.some(nextSnapshot),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
    });
    if (receivedSnapshot) {
      const session = yield* Ref.get(activeSubscriptionSession);
      if (session !== null) {
        yield* Ref.set(lastAuthoritativeSession, session);
      }
    }
    yield* Queue.offer(persistence, nextSnapshot);
  });

  // Body of applyItems, running under applyLock.
  const applyItemsLocked = Effect.fn("EnvironmentShellState.applyItemsLocked")(function* (
    items: ReadonlyArray<OrchestrationShellStreamItem>,
  ) {
    let run: Array<Exclude<OrchestrationShellStreamItem, { kind: "synchronized" }>> = [];
    for (const item of items) {
      if (item.kind !== "synchronized") {
        run.push(item);
        continue;
      }
      if (run.length > 0) {
        yield* applyItemRun(run);
        run = [];
      }
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.snapshot)
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
    }
    if (run.length > 0) {
      yield* applyItemRun(run);
    }
  });

  // Applies a batch of stream items. Batches form adaptively downstream of
  // the subscription's Stream.buffer: whatever accumulated while the
  // previous batch applied folds into the next one, so publication count
  // tracks how fast the client applies instead of how fast the server emits.
  const applyItems = (
    items: ReadonlyArray<DynamicSubscriptionItem<OrchestrationShellStreamItem>>,
  ) =>
    applyLock.withPermits(1)(
      Effect.gen(function* () {
        const activeGeneration = yield* Ref.get(activeSubscriptionGeneration);
        const currentSession = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
        const activeItems = items
          .filter((item) => item.session === currentSession && item.generation === activeGeneration)
          .map((item) => item.value);
        if (activeItems.length > 0) {
          yield* applyItemsLocked(activeItems);
        }
      }),
    );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamicWithGeneration(
      ORCHESTRATION_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session, generation) {
        // Wait for an in-flight old-session fold, then invalidate every old
        // item still buffered downstream before reading the resume baseline.
        yield* applyLock.withPermits(1)(
          Effect.all(
            [
              Ref.set(activeSubscriptionSession, session),
              Ref.set(activeSubscriptionGeneration, generation),
            ],
            { discard: true },
          ),
        );
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.shellResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        // Foreground resubscriptions on the same live session can resume from
        // the in-memory cursor. A new session reloads the authoritative HTTP
        // snapshot so a valid cursor cannot preserve incomplete cached data.
        const hasAuthoritativeSnapshot = (yield* Ref.get(lastAuthoritativeSession)) === session;
        let canResume = hasAuthoritativeSnapshot;
        let current = yield* SubscriptionRef.get(state);
        if (!hasAuthoritativeSnapshot || Option.isNone(current.snapshot)) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader.load(prepared);
          if (Option.isSome(httpSnapshot)) {
            // Apply the seed and capture the resulting cursor in one critical
            // section so a batch draining concurrently cannot slip between
            // them; the fold itself is lock-serialized for the same reason.
            current = yield* applyLock.withPermits(1)(
              applyItemsLocked([{ kind: "snapshot", snapshot: httpSnapshot.value }]).pipe(
                Effect.andThen(SubscriptionRef.get(state)),
              ),
            );
            canResume = true;
          }
        }

        // If the authoritative refresh failed, omit the cached cursor so the
        // socket fallback sends a complete snapshot for this new session.
        if (!canResume || Option.isNone(current.snapshot)) {
          return supportsCompletionMarker ? { requestCompletionMarker: true as const } : {};
        }
        if (!supportsCompletionMarker) {
          // Without a completion marker there is no synchronized signal for a
          // resumed subscription, so report live immediately, like threads.
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: "live" as const,
            error: Option.none(),
          }));
        }
        return {
          afterSequence: current.snapshot.value.snapshotSequence,
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(
      // Decouple delivery from application: the buffer's consumer receives
      // whatever accumulated while the previous batch applied — one item when
      // the client keeps up, the whole backlog when it does not — adding no
      // latency to either case. The finite capacity preserves the transport's
      // end-to-end backpressure: past it, the un-applied backlog waits on the
      // server instead of growing this client's heap.
      Stream.buffer({ capacity: 4096, strategy: "suspend" }),
      Stream.chunks,
      Stream.runForEach(applyItems),
    ),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

export function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
  readonly latestSnapshotUpdatedAt: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
  latestSnapshotUpdatedAt: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError &&
    left.latestSnapshotUpdatedAt === right.latestSnapshotUpdatedAt
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;
    let latestSnapshotUpdatedAt: string | null = null;

    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= state.status === "cached";
      hasLiveShell ||= state.status === "live";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
      const updatedAt = state.snapshot.value.updatedAt;
      if (latestSnapshotUpdatedAt === null || updatedAt > latestSnapshotUpdatedAt) {
        latestSnapshotUpdatedAt = updatedAt;
      }
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
      latestSnapshotUpdatedAt,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ShellSnapshotLoader | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  return {
    stateAtom,
    stateValueAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
