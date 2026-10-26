import {
  isOrchestrationV2WorkActive,
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { request, subscribeDynamic } from "../rpc/client.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import {
  applyHistoryPageMeta,
  clearActiveHistoryLoading,
  EMPTY_THREAD_HISTORY_META,
  isActiveHistoryRequestCursor,
  mergeOlderHistoryIntoProjection,
  type ThreadHistoryMeta,
} from "./threadHistoryMerge.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import { makeThreadRequestsResolvedAnnouncer, pendingRuntimeRequestIds } from "./threadRequests.ts";
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
    expanded: false,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
  };
}

function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  // A complete bounded snapshot still proves paging support. Retain that evidence
  // so a thread that grows while closed can resume with a bounded fallback.
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
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

// Only still-active local copies take the server's item: events applied meanwhile win,
// and inherited rows belong to another thread.
function settleTurnItems(
  threadId: ThreadIdType,
  projection: OrchestrationV2ThreadProjection,
  settled: ReadonlyMap<string, OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection {
  let changed = false;
  const settle = (item: OrchestrationV2TurnItem, id: string) => {
    const server = settled.get(id);
    if (server === undefined || !isOrchestrationV2WorkActive(item.status)) return item;
    changed = true;
    return server;
  };
  const turnItems = projection.turnItems.map((item) => settle(item, item.id));
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    if (row.sourceThreadId !== threadId) return row;
    const item = settle(row.item, row.sourceItemId);
    return item === row.item ? row : { ...row, item };
  });
  return changed ? { ...projection, turnItems, visibleTurnItems } : projection;
}

interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
  readonly acceptsBoundedSnapshots?: boolean;
}

interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  projection: OrchestrationV2ThreadProjection | null,
  sequence: number,
  history: Pick<ThreadHistoryMeta, "historyCursor" | "hasMoreHistory" | "latestLocalTurnOrdinal">,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== projection)
    return false;
  const currentHistory = current.state.history;
  return (
    currentHistory.historyCursor === history.historyCursor &&
    currentHistory.hasMoreHistory === history.hasMoreHistory &&
    (!(history.hasMoreHistory || history.historyCursor !== null) ||
      currentHistory.latestLocalTurnOrdinal === history.latestLocalTurnOrdinal)
  );
}

function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status:
      value.status === "deleted" || (value.status === "live" && Option.isSome(value.data))
        ? value.status
        : statusWithoutLiveData(value.data),
    error: Option.none(),
    history: { ...value.history, loading: false, error: null },
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
  const historyController = yield* Effect.serviceOption(
    ThreadHistoryController.ThreadHistoryController,
  );
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  const dpopSigner = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const retained = resumeCache?.snapshot;
  const owner = {};
  if (resumeCache) resumeCache.owner = owner;
  const cached =
    retained === undefined
      ? yield* cache.loadThread(environmentId, threadId).pipe(
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
        )
      : Option.none<OrchestrationV2ThreadDetailSnapshot>();
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const initialState: EnvironmentThreadState = retained
    ? cachedThreadState(retained.state)
    : {
        data: cachedThread,
        status: statusWithoutLiveData(cachedThread),
        error: Option.none(),
        history: Option.match(cached, {
          onNone: () => EMPTY_THREAD_HISTORY_META,
          onSome: historyMetaFromCachedSnapshot,
        }),
      };
  const state = yield* SubscriptionRef.make(initialState);
  const canLoadHistory = Option.isSome(httpClient) && Option.isSome(historyController);
  const acceptsBoundedSocketSnapshots = yield* Ref.make(canLoadHistory);
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const initialSequence =
    retained?.sequence ??
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence });
  const lastSequence = yield* SubscriptionRef.make(initialSequence);
  let committed: ThreadResumeSnapshot = {
    state: initialState,
    sequence: initialSequence,
    persisted: retained?.persisted ?? Option.isSome(cached),
    acceptsBoundedSnapshots: canLoadHistory,
  };
  if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  const awaitingCompletion = yield* Ref.make(false);
  const applyLock = yield* Semaphore.make(1);
  // Save only completed data/cursor updates. A canceled scope must not cache
  // a cursor whose event has not reached the data yet.
  const announceRequests = makeThreadRequestsResolvedAnnouncer(environmentId, threadId);
  const remember = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const sequence = yield* SubscriptionRef.get(lastSequence);
    // Only a synchronized projection from the scope that owns the thread is
    // authoritative: a cached one can predate a request the user already has
    // drafts for, and a superseded scope can lag its successor.
    const owns = resumeCache === undefined || resumeCache.owner === owner;
    if (owns && current.status === "deleted") announceRequests([]);
    else if (owns && current.status === "live" && Option.isSome(current.data))
      announceRequests(pendingRuntimeRequestIds(current.data.value));
    committed = {
      state: current,
      sequence,
      acceptsBoundedSnapshots: yield* Ref.get(acceptsBoundedSocketSnapshots),
      persisted:
        committed.persisted &&
        matchesThreadSnapshot(committed, Option.getOrNull(current.data), sequence, current.history),
    };
    if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  });
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);
  let queuedSnapshot = Option.getOrUndefined(cached);
  let savedSnapshot = queuedSnapshot;
  const queuePersist = (snapshot: OrchestrationV2ThreadDetailSnapshot) =>
    Effect.suspend(() => {
      queuedSnapshot = snapshot;
      return Queue.offer(persistence, snapshot);
    });

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    if (committed.state.status === "deleted") return;
    if (
      committed.persisted &&
      matchesThreadSnapshot(
        committed,
        snapshot.projection,
        snapshot.snapshotSequence,
        historyMetaFromCachedSnapshot(snapshot),
      )
    )
      return;
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          savedSnapshot = snapshot;
          if (
            !matchesThreadSnapshot(
              committed,
              snapshot.projection,
              snapshot.snapshotSequence,
              historyMetaFromCachedSnapshot(snapshot),
            )
          )
            return;
          committed = { ...committed, persisted: true };
          if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
        }),
      ),
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

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const { state: current, sequence: snapshotSequence } = committed;
      return Option.match(current.data, {
        onNone: () => Effect.void,
        onSome: (projection) =>
          shouldPersistThread(projection, current.history)
            ? persist(
                snapshotToPersist(
                  snapshotSequence,
                  projection,
                  current.history,
                  committed.acceptsBoundedSnapshots === true,
                ),
              )
            : // The consumer may still be waiting out its delay; an expanded thread queues
              // only cache repairs, which must survive leaving the thread.
              queuedSnapshot !== undefined && queuedSnapshot !== savedSnapshot
              ? persist(queuedSnapshot)
              : Effect.void,
      });
    }),
  );

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setConnecting = SubscriptionRef.update(state, (current) =>
    current.status === "deleted" || Option.isSome(current.error)
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted" || Option.isSome(current.error)
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
  const setStreamError = (message: string) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(message),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
    options?: {
      readonly resetHistory?: boolean;
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
        status: Option.isSome(previous.error)
          ? ("cached" as const)
          : waiting
            ? ("synchronizing" as const)
            : ("live" as const),
        error: previous.error,
        history,
      };
    });
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path. Progressive meta rides along when the window is incomplete.
    if (shouldPersistThread(thread, next.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* queuePersist(
        snapshotToPersist(
          snapshotSequence,
          thread,
          next.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
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
    yield* remember;
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
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

  type EventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
  type SequencedItem = Extract<
    OrchestrationV2ThreadStreamItem,
    { kind: "event" | "unknown-event" }
  >;
  const applyEventsLocked = Effect.fn("EnvironmentThreadState.applyEventsLocked")(function* (
    items: ReadonlyArray<SequencedItem>,
  ) {
    const appliedSequence = yield* SubscriptionRef.get(lastSequence);
    let sequence = appliedSequence;
    const fresh: EventItem[] = [];
    for (const item of items) {
      if (item.sequence <= sequence) continue;
      sequence = item.sequence;
      if (item.kind === "event") {
        fresh.push(item);
        continue;
      }
      yield* Effect.logDebug("Skipped a thread event type this client does not know.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          eventType: item.eventType.slice(0, 64),
          sequence: item.sequence,
        }),
      );
    }
    if (sequence === appliedSequence) return;
    yield* SubscriptionRef.set(lastSequence, sequence);
    if (fresh.length === 0) return;

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

    const applyEvent = (
      current: EnvironmentThreadState,
      item: EventItem,
    ): readonly [EventApplyResult, EnvironmentThreadState] => {
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
      const partial =
        current.history.hasMoreHistory || current.history.historyCursor !== null
          ? {
              partialTimeline: true as const,
              latestLocalTurnOrdinal: current.history.latestLocalTurnOrdinal,
            }
          : undefined;
      const next = applyOrchestrationV2ProjectionEvent(current.data.value, item.event, partial);
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
    };

    const result = yield* SubscriptionRef.modify(
      state,
      (current): readonly [EventApplyResult, EnvironmentThreadState] => {
        let result: EventApplyResult = { _tag: "noop" };
        for (const item of fresh) {
          const [applied, next] = applyEvent(current, item);
          current = next;
          if (applied._tag !== "noop") result = applied;
          if (applied._tag === "delete") break;
        }
        return [result, current];
      },
    );

    if (result._tag === "delete") {
      yield* setDeleted();
      return;
    }
    if (result._tag === "applied" && shouldPersistThread(result.projection, result.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* queuePersist(
        snapshotToPersist(
          snapshotSequence,
          result.projection,
          result.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
    }
  });

  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted" && Option.isNone(current.error)
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      const hasProgressiveHistory =
        item.historyCursor !== undefined ||
        item.hasMoreHistory !== undefined ||
        item.latestLocalTurnOrdinal !== undefined;
      yield* setThread(
        boundedSnapshotProjection(item),
        hasProgressiveHistory
          ? {
              history: {
                historyCursor: item.historyCursor ?? null,
                hasMoreHistory: item.hasMoreHistory ?? false,
                loading: false,
                error: null,
                expanded: false,
                latestLocalTurnOrdinal: item.latestLocalTurnOrdinal ?? null,
              },
            }
          : { resetHistory: true },
      );
      return;
    }

    yield* applyEventsLocked([item]);
  });

  const applyItems = Effect.fn("EnvironmentThreadState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationV2ThreadStreamItem>,
  ) {
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        let events: SequencedItem[] = [];
        for (const item of items) {
          if (
            item.kind === "unknown-event" ||
            (item.kind === "event" && item.event.type !== "thread.deleted")
          ) {
            events.push(item);
            continue;
          }
          yield* applyEventsLocked(events);
          events = [];
          yield* applyItemLocked(item);
        }
        yield* applyEventsLocked(events);
        yield* remember;
      }),
    );
  });

  const loadEarlier = Effect.fn("EnvironmentThreadState.loadEarlier")(function* (
    throughEntryId?: string,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (
      current.status === "deleted" ||
      Option.isNone(current.data) ||
      !current.history.hasMoreHistory ||
      current.history.historyCursor === null
    ) {
      return { _tag: "noop" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    if (current.history.loading) {
      return { _tag: "busy" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }

    // Capture the cursor that initiated this request. Completions/failures must
    // no-op if a socket or new bounded snapshot replaced progressive meta mid-flight.
    const requestCursor = current.history.historyCursor;
    yield* patchHistoryMeta((history) =>
      isActiveHistoryRequestCursor(requestCursor, history)
        ? { ...history, loading: true, error: null }
        : history,
    );

    const failLoad = (message: string) =>
      SubscriptionRef.modify(
        state,
        (
          latest,
        ): readonly [
          ThreadHistoryController.ThreadHistoryLoadEarlierResult,
          EnvironmentThreadState,
        ] =>
          isActiveHistoryRequestCursor(requestCursor, latest.history)
            ? [
                { _tag: "error", message },
                {
                  ...latest,
                  history: { ...latest.history, loading: false, error: message },
                },
              ]
            : [{ _tag: "noop" }, latest],
      );

    const runLoad = Effect.gen(function* () {
      const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(preparedOption) || Option.isNone(httpClient))
        return yield* failLoad("Environment is not connected.");

      const views =
        throughEntryId === undefined ? [undefined] : ["conversation" as const, undefined];
      for (const view of views) {
        const pageResult = yield* fetchEnvironmentThreadHistoryPage({
          prepared: preparedOption.value,
          threadId,
          cursor: requestCursor,
          throughEntryId,
          view,
          signer: dpopSigner,
          remoteAuthorization,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient.value), Effect.result);
        if (Result.isFailure(pageResult))
          return yield* failLoad(formatHistoryError(pageResult.failure));
        const page = pageResult.success;
        const complete = view === undefined;
        const waiting = yield* Ref.get(awaitingCompletion);
        const result = yield* applyLock.withPermits(1)(
          SubscriptionRef.modify(
            state,
            (
              latest,
            ): readonly [
              ThreadHistoryController.ThreadHistoryLoadEarlierResult,
              EnvironmentThreadState,
            ] => {
              if (!isActiveHistoryRequestCursor(requestCursor, latest.history))
                return [{ _tag: "noop" }, latest];
              if (Option.isNone(latest.data) || latest.status === "deleted")
                return [{ _tag: "noop" }, { ...latest, history: EMPTY_THREAD_HISTORY_META }];
              return [
                { _tag: "loaded" },
                {
                  ...latest,
                  data: Option.some(mergeOlderHistoryIntoProjection(latest.data.value, page.items)),
                  status: complete && waiting ? "synchronizing" : latest.status,
                  history: complete
                    ? applyHistoryPageMeta(latest.history, page)
                    : { ...latest.history, expanded: true },
                },
              ];
            },
          ),
        );
        if (result._tag !== "loaded") return result;
        if (complete) yield* remember;
      }
      return { _tag: "loaded" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    });

    return yield* runLoad.pipe(
      Effect.onInterrupt(() =>
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          history: clearActiveHistoryLoading(requestCursor, latest.history),
        })),
      ),
    );
  });

  // A cached item can stay running after the server finished it, and no event will ever
  // name it again: it can sit outside every bounded window, and a repeated Stop records
  // nothing new. Stop asks the server about each pending item instead of
  // inferring status from what a snapshot omits, and settles only those items.
  const reconcilePendingWork = Effect.fn("EnvironmentThreadState.reconcilePendingWork")(
    function* () {
      const current = yield* SubscriptionRef.get(state);
      if (current.status === "deleted" || Option.isNone(current.data)) return;
      const pending = pendingBackgroundTurnItems(current.data.value);
      if (pending.length === 0) return;
      const queried = new Set<string>(pending.map((item) => item.id));
      const fetched = yield* Effect.forEach(
        pending,
        (item) =>
          request(ORCHESTRATION_V2_WS_METHODS.getTurnItem, { threadId, itemId: item.id }).pipe(
            Effect.timeout("10 seconds"),
            Effect.map((result) => result.item),
            Effect.orElseSucceed(() => null),
          ),
        { concurrency: 4 },
      );
      const settled = new Map(
        fetched.flatMap((item) =>
          item === null || isOrchestrationV2WorkActive(item.status) ? [] : [[item.id, item]],
        ),
      );
      yield* applyLock.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* SubscriptionRef.get(state);
          if (latest.status === "deleted" || Option.isNone(latest.data)) return;
          const thread = settleTurnItems(threadId, latest.data.value, settled);
          if (thread !== latest.data.value) {
            yield* setThread(thread);
            yield* remember;
          }
          // An expanded timeline is never saved, so reload would bring the stale row back.
          // Repair the snapshot last handed to the cache instead, keeping its window and cursor.
          // A resumed state skipped the cache load, so read the saved snapshot then.
          if (shouldPersistThread(thread, latest.history)) return;
          // A terminal event that landed during the lookup is newer than any reply, and the
          // expanded live state never saves it, whatever the lookup returned.
          const latestItems = new Map(settled);
          for (const item of thread.turnItems) {
            if (queried.has(item.id) && !isOrchestrationV2WorkActive(item.status)) {
              latestItems.set(item.id, item);
            }
          }
          if (latestItems.size === 0) return;
          const saved =
            queuedSnapshot ??
            Option.getOrUndefined(
              yield* cache
                .loadThread(environmentId, threadId)
                .pipe(Effect.orElseSucceed(() => Option.none())),
            );
          if (saved === undefined) return;
          const projection = settleTurnItems(threadId, saved.projection, latestItems);
          if (projection !== saved.projection) yield* queuePersist({ ...saved, projection });
        }),
      );
    },
  );

  if (Option.isSome(historyController)) {
    const scope = yield* Scope.Scope;
    const registration = yield* historyController.value.register(environmentId, threadId, {
      loadEarlier: (throughEntryId) =>
        loadEarlier(throughEntryId).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
      reconcilePendingWork: () =>
        reconcilePendingWork().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkIn(scope),
          Effect.flatMap(Fiber.join),
        ),
    });
    yield* Effect.addFinalizer(() => historyController.value.unregister(registration));
  }

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setConnecting;
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

  // Only the first subscription after a warm live resume keeps the retained
  // status. A replacement session or foreground resubscribe on the same scope
  // may have missed events, so those show sync progress until confirmed.
  const resumingLive = yield* Ref.make(initialState.status === "live");
  const markSynchronizing = Effect.gen(function* () {
    if (yield* Ref.get(resumingLive)) return;
    yield* SubscriptionRef.update(state, (current) =>
      current.status === "deleted"
        ? current
        : { ...current, status: "synchronizing" as const, error: Option.none() },
    );
  });

  yield* markSynchronizing;
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
        yield* markSynchronizing;
        yield* Ref.set(resumingLive, false);

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
          const httpResult: ThreadSnapshotLoader.ThreadSnapshotLoadResult =
            yield* snapshotLoader.load(prepared, threadId);
          switch (httpResult._tag) {
            case "present": {
              if (canLoadHistory && httpResult.history !== undefined) {
                yield* Ref.set(acceptsBoundedSocketSnapshots, true);
              }
              // Atomic projection + progressive meta so a settled bounded window
              // never persists as a complete full-timeline cache entry. Socket
              // snapshots still go through applyItem (resetHistory).
              yield* applyLock.withPermits(1)(
                Effect.gen(function* () {
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
                  yield* remember;
                }),
              );
              current = yield* SubscriptionRef.get(state);
              break;
            }
            case "missing": {
              yield* setDeleted();
              return yield* Effect.never;
            }
            case "unavailable": {
              break;
            }
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        const acceptBoundedSnapshot = yield* Ref.get(acceptsBoundedSocketSnapshots);
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
          ...(acceptBoundedSnapshot
            ? {
                acceptBoundedSnapshot: true as const,
                acceptCompactTurnItems: true as const,
                acceptCompactIds: true as const,
              }
            : {}),
          acceptDedupedBodies: true as const,
        };
      }),
      {
        onDefect: () => setStreamError("Could not synchronize the thread."),
        onExpectedFailure: (cause) => setStreamError(formatThreadError(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEachArray(applyItems)),
  );

  return state;
});

function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, resumeCache).pipe(Effect.map(SubscriptionRef.changes)),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ThreadSnapshotLoader.ThreadSnapshotLoader
    | R,
    E
  >,
) {
  // Cache definitions must outlive collectible live-atom definitions. The
  // registry retains these nodes without retaining environment or RPC scopes.
  const resumeFamily = Atom.family((key: string) =>
    Atom.make((): ThreadResumeCache => ({
      snapshot: undefined,
      owner: undefined,
    })).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    const resumeAtom = resumeFamily(key);
    return runtime
      .atom(
        (get) => {
          get.mount(resumeAtom);
          const resume = get.once(resumeAtom);
          const live = threadStateChanges(environmentId, threadId, resume);
          return resume.snapshot === undefined
            ? live
            : Stream.concat(Stream.succeed(cachedThreadState(resume.snapshot.state)), live);
        },
        {
          initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
        },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state:${key}`));
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * as BoundedThreadSnapshotLoader from "./boundedThreadSnapshotHttp.ts";
export * as ThreadHistoryController from "./threadHistoryController.ts";
export type { ThreadHistoryLoadEarlierResult } from "./threadHistoryController.ts";
export * from "./threadHistoryMerge.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadFamilies.ts";
export * from "./olderSettledThreads.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
