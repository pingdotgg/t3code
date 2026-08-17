import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  ThreadHistoryController,
  type ThreadHistoryLoadEarlierResult,
} from "./threadHistoryController.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import {
  applyHistoryPageMeta,
  clearActiveHistoryLoading,
  EMPTY_THREAD_HISTORY_META,
  isActiveHistoryRequestCursor,
  mergeOlderHistoryIntoProjection,
  type ThreadHistoryMeta,
} from "./threadHistoryMerge.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotLoadResult } from "./threadSnapshotHttp.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function formatHistoryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not load earlier activity.";
}

function historyMetaFromCachedSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
): ThreadHistoryMeta {
  const historyCursor = snapshot.historyCursor ?? null;
  const hasMoreHistory = snapshot.hasMoreHistory ?? false;
  return {
    historyCursor,
    hasMoreHistory,
    loading: false,
    error: null,
    // Cache never stores expanded progressive history (load-earlier growth).
    expanded: false,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
  };
}

function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): OrchestrationV2ThreadDetailSnapshot {
  // Persist progressive meta with the bounded window so warm resume restores the
  // history cursor instead of looking like a complete full-projection cache hit.
  if (history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  // After the user loads older pages the in-memory timeline can grow large.
  // Keep those expanded projections out of the monolithic cache.
  if (history.expanded) {
    return false;
  }
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const historyController = yield* Effect.serviceOption(ThreadHistoryController);
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  const dpopSigner = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const cachedHistory = Option.match(cached, {
    onNone: () => EMPTY_THREAD_HISTORY_META,
    onSome: historyMetaFromCachedSnapshot,
  });
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    history: cachedHistory,
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
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

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
    options?: {
      /** Socket/full snapshots: drop progressive meta with the new timeline. */
      readonly resetHistory?: boolean;
      /**
       * Explicit progressive meta installed atomically with the projection
       * (bounded HTTP). Wins over resetHistory when both are supplied.
       */
      readonly history?: ThreadHistoryMeta;
    },
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    // Atomic with concurrent history meta updates: never get-then-set the whole
    // state when only the projection changes. Bounded installs pass history so
    // projection + cursor persist together in one enqueue.
    const next = yield* SubscriptionRef.updateAndGet(state, (previous) => {
      const history =
        options?.history !== undefined
          ? options.history
          : options?.resetHistory === true
            ? EMPTY_THREAD_HISTORY_META
            : previous.history;
      return {
        ...previous,
        data: Option.some(thread),
        status: waiting ? ("synchronizing" as const) : ("live" as const),
        error: Option.none(),
        history,
      };
    });
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path. Progressive meta rides along when the window is incomplete.
    if (shouldPersistThread(thread, next.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, snapshotToPersist(snapshotSequence, thread, next.history));
    }
  });

  const patchHistoryMeta = (patch: (history: ThreadHistoryMeta) => ThreadHistoryMeta) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      history: patch(current.history),
    }));

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      // True socket/full snapshots replace the full timeline; progressive cursor
      // state from a prior bounded window must not stick around. Bounded HTTP
      // installs call setThread with explicit history and never route here.
      yield* setThread(item.projection, { resetHistory: true });
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.sequence);

    const waiting = yield* Ref.get(awaitingCompletion);
    // Apply against the latest projection/history in one update so a concurrent
    // loadEarlier merge (or history-meta patch) cannot be clobbered by a stale
    // get-then-set rebuild.
    type EventApplyResult =
      | { readonly _tag: "noop" }
      | { readonly _tag: "delete" }
      | {
          readonly _tag: "applied";
          readonly projection: OrchestrationV2ThreadProjection;
          readonly history: ThreadHistoryMeta;
        };

    const result = yield* SubscriptionRef.modify(
      state,
      (current): readonly [EventApplyResult, EnvironmentThreadState] => {
        if (current.status === "deleted") {
          return [{ _tag: "noop" }, current];
        }
        if (Option.isNone(current.data)) {
          return [
            item.event.type === "thread.deleted" ? { _tag: "delete" } : { _tag: "noop" },
            current,
          ];
        }
        if (item.event.type === "thread.deleted") {
          return [{ _tag: "delete" }, current];
        }

        // Incomplete progressive windows only (hasMore or open cursor). Do not
        // use expanded: it remains true after the last page as a cache marker.
        // Full/web and fully-loaded timelines keep default append-on-miss.
        const partial =
          current.history.hasMoreHistory || current.history.historyCursor !== null
            ? {
                partialTimeline: true as const,
                latestLocalTurnOrdinal: current.history.latestLocalTurnOrdinal,
              }
            : undefined;
        const next = applyOrchestrationV2ProjectionEvent(current.data.value, item.event, partial);
        // True no-op when the reducer deliberately returns the current projection
        // reference (e.g. dropped old partial-timeline turn-item). Do not clear
        // stream error/status or enqueue persistence.
        if (next === null || next === current.data.value) {
          return [{ _tag: "noop" }, current];
        }

        let history = current.history;
        if (partial !== undefined && item.event.type === "turn-item.updated") {
          const ordinal = item.event.payload.ordinal;
          const watermark = history.latestLocalTurnOrdinal;
          if (watermark === null || ordinal > watermark) {
            history = { ...history, latestLocalTurnOrdinal: ordinal };
          }
        }

        const updated: EnvironmentThreadState = {
          ...current,
          data: Option.some(next),
          status: waiting ? "synchronizing" : "live",
          error: Option.none(),
          history,
        };
        return [{ _tag: "applied", projection: next, history: updated.history }, updated];
      },
    );

    if (result._tag === "delete") {
      yield* setDeleted();
      return;
    }
    if (result._tag === "applied" && shouldPersistThread(result.projection, result.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(
        persistence,
        snapshotToPersist(snapshotSequence, result.projection, result.history),
      );
    }
  });

  const loadEarlier = Effect.fn("EnvironmentThreadState.loadEarlier")(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (
      current.status === "deleted" ||
      Option.isNone(current.data) ||
      !current.history.hasMoreHistory ||
      current.history.historyCursor === null
    ) {
      return { _tag: "noop" } satisfies ThreadHistoryLoadEarlierResult;
    }
    if (current.history.loading) {
      return { _tag: "busy" } satisfies ThreadHistoryLoadEarlierResult;
    }

    // Capture the cursor that initiated this request. Completions/failures must
    // no-op if a socket or new bounded snapshot replaced progressive meta mid-flight.
    const requestCursor = current.history.historyCursor;
    yield* patchHistoryMeta((history) =>
      isActiveHistoryRequestCursor(requestCursor, history)
        ? { ...history, loading: true, error: null }
        : history,
    );

    const runLoad = Effect.gen(function* () {
      const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(preparedOption) || Option.isNone(httpClient)) {
        const message = "Environment is not connected.";
        const stillCurrent = yield* SubscriptionRef.modify(
          state,
          (latest): readonly [boolean, EnvironmentThreadState] => {
            if (!isActiveHistoryRequestCursor(requestCursor, latest.history)) {
              return [false, latest];
            }
            return [
              true,
              {
                ...latest,
                history: { ...latest.history, loading: false, error: message },
              },
            ];
          },
        );
        if (!stillCurrent) {
          return { _tag: "noop" } satisfies ThreadHistoryLoadEarlierResult;
        }
        return {
          _tag: "error",
          message,
        } satisfies ThreadHistoryLoadEarlierResult;
      }

      const pageResult = yield* fetchEnvironmentThreadHistoryPage({
        prepared: preparedOption.value,
        threadId,
        cursor: requestCursor,
        signer: dpopSigner,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient.value), Effect.result);

      if (Result.isFailure(pageResult)) {
        const message = formatHistoryError(pageResult.failure);
        // Only mark error when this request's cursor is still active. Leave
        // stream/status/error alone so concurrent live updates stay intact.
        const stillCurrent = yield* SubscriptionRef.modify(
          state,
          (latest): readonly [boolean, EnvironmentThreadState] => {
            if (!isActiveHistoryRequestCursor(requestCursor, latest.history)) {
              return [false, latest];
            }
            return [
              true,
              {
                ...latest,
                history: { ...latest.history, loading: false, error: message },
              },
            ];
          },
        );
        if (!stillCurrent) {
          return { _tag: "noop" } satisfies ThreadHistoryLoadEarlierResult;
        }
        return { _tag: "error", message } satisfies ThreadHistoryLoadEarlierResult;
      }

      const page = pageResult.success;
      const waiting = yield* Ref.get(awaitingCompletion);
      // Single atomic merge against whatever is current after the await so a
      // concurrent applyItem cannot be clobbered by a stale get/set pair.
      return yield* SubscriptionRef.modify(
        state,
        (latest): readonly [ThreadHistoryLoadEarlierResult, EnvironmentThreadState] => {
          // Stale page: socket/full snapshot or newer bounded install changed the
          // progressive cursor while this request was in flight. Never mutate the
          // replacement meta (including deleted/empty installs).
          if (!isActiveHistoryRequestCursor(requestCursor, latest.history)) {
            return [{ _tag: "noop" }, latest];
          }
          if (Option.isNone(latest.data) || latest.status === "deleted") {
            return [
              { _tag: "noop" },
              {
                ...latest,
                history: EMPTY_THREAD_HISTORY_META,
              },
            ];
          }

          const merged = mergeOlderHistoryIntoProjection(latest.data.value, page.items);
          const history = applyHistoryPageMeta(latest.history, page);
          return [
            { _tag: "loaded" },
            {
              ...latest,
              data: Option.some(merged),
              status: waiting
                ? ("synchronizing" as const)
                : latest.status === "live"
                  ? ("live" as const)
                  : latest.status,
              history,
            },
          ];
        },
      );
    });

    // On Effect interruption only: clear loading when this request cursor is
    // still active. Never mutate stream status/error from the interrupt path.
    return yield* runLoad.pipe(
      Effect.onInterrupt(() =>
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          history: clearActiveHistoryLoading(requestCursor, latest.history),
        })),
      ),
    );
  });

  if (Option.isSome(historyController)) {
    const registration = yield* historyController.value.register(environmentId, threadId, {
      loadEarlier: () => loadEarlier(),
    });
    yield* Effect.addFinalizer(() => historyController.value.unregister(registration));
  }

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

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        let current = yield* SubscriptionRef.get(state);
        // A prior definitive miss (or delete event) already cleared this thread.
        // Park the subscription attempt without opening the socket so we do not
        // retry forever against a known-missing id.
        if (current.status === "deleted") {
          return yield* Effect.never;
        }

        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        if (Option.isNone(current.data)) {
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
          const httpResult: ThreadSnapshotLoadResult = yield* snapshotLoader.load(
            prepared,
            threadId,
          );
          switch (httpResult._tag) {
            case "present": {
              // Atomic projection + progressive meta so a settled bounded window
              // never persists as a complete full-timeline cache entry. Socket
              // snapshots still go through applyItem (resetHistory).
              yield* SubscriptionRef.set(lastSequence, httpResult.snapshot.snapshotSequence);
              const history: ThreadHistoryMeta =
                httpResult.history !== undefined
                  ? {
                      historyCursor: httpResult.history.historyCursor,
                      hasMoreHistory: httpResult.history.hasMoreHistory,
                      loading: false,
                      error: null,
                      expanded: false,
                      latestLocalTurnOrdinal: httpResult.history.latestLocalTurnOrdinal ?? null,
                    }
                  : EMPTY_THREAD_HISTORY_META;
              yield* setThread(httpResult.snapshot.projection, { history });
              current = yield* SubscriptionRef.get(state);
              break;
            }
            case "missing": {
              // Definitive HTTP 404: clear any stale cache and do not open or
              // retry a socket subscription for this attempt.
              yield* setDeleted();
              return yield* Effect.never;
            }
            case "unavailable": {
              // Transient HTTP failure: fall through to the socket path.
              break;
            }
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (projection) =>
            shouldPersistThread(projection, current.history)
              ? persist(snapshotToPersist(snapshotSequence, projection, current.history))
              : Effect.void,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./boundedThreadSnapshotHttp.ts";
export * from "./threadHistoryController.ts";
export * from "./threadHistoryMerge.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
