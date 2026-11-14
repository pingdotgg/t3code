import {
  isOrchestrationV2WorkActive,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { request, subscribeDynamic } from "../rpc/client.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import { formatThreadError } from "./threadHistoryErrors.ts";
import {
  cachedThreadState,
  historyMetaFromCachedSnapshot,
  matchesThreadSnapshot,
  settleTurnItems,
  shouldPersistThread,
  snapshotToPersist,
  statusWithoutLiveData,
  type ThreadResumeCache,
  type ThreadResumeSnapshot,
} from "./threadStateSnapshot.ts";
import { makeThreadHistoryLoadEarlier } from "./threadHistoryLoadEarlier.ts";
import { makeThreadRequestsResolvedAnnouncer, pendingRuntimeRequestIds } from "./threadRequests.ts";
import { type EnvironmentThreadState } from "./threadState.ts";

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
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const initialSequence =
    retained?.sequence ??
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence });
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
        sequence: initialSequence,
      };
  const state = yield* SubscriptionRef.make(initialState);
  const canLoadHistory = Option.isSome(httpClient) && Option.isSome(historyController);
  const acceptsBoundedSocketSnapshots = yield* Ref.make(canLoadHistory);
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
    const sequence = yield* SubscriptionRef.get(lastSequence);
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
        sequence,
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
      sequence: yield* SubscriptionRef.get(lastSequence),
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
        // A batch that changed nothing keeps its state object, so readers do not re-render.
        return [result, result._tag === "noop" ? current : { ...current, sequence }];
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

  const loadEarlier = makeThreadHistoryLoadEarlier({
    state,
    threadId,
    supervisor,
    httpClient,
    dpopSigner,
    remoteAuthorization,
    patchHistoryMeta,
    remember,
    applyLock,
    awaitingCompletion,
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
      loadEarlier: (throughEntryId, workAnchorId) =>
        loadEarlier(throughEntryId, workAnchorId).pipe(
          Effect.forkIn(scope),
          Effect.flatMap(Fiber.join),
        ),
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

        yield* Effect.ignore(session.initialConfig);
        yield* Ref.set(awaitingCompletion, true);
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
              // A 404 also means "not created yet". Only a delete event may outlive this mount.
              if (resumeCache?.owner === owner) resumeCache.snapshot = undefined;
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

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          requestCompletionMarker: true as const,
          ...(acceptBoundedSnapshot
            ? {
                acceptBoundedSnapshot: true as const,
                acceptDeferredWork: true as const,
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
