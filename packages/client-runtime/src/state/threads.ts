import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadDetailPage,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader, type ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadPageState,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

/**
 * Turn window sizes for paginated thread loads: the initial page covers the
 * last 10 user-anchored turns (subagent/fan-out turns ride along), each
 * "load earlier" tap fetches 20 more. Sized so first paint on the heaviest
 * observed threads stays around 100K gzipped while median threads load fully.
 */
export const INITIAL_THREAD_USER_TURN_LIMIT = 10;
export const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;

function pageStateFromSnapshot(
  page: OrchestrationThreadDetailPage | undefined,
): Option.Option<EnvironmentThreadPageState> {
  return page === undefined
    ? Option.none()
    : Option.some({
        beforeCursor: page.beforeCursor,
        hasMore: page.hasMore,
        loadingOlder: false,
      });
}

// Channel from UI actions to the live per-thread state machines: machines are
// scoped inside anonymous atoms, so `requestOlderThreadTurns` reaches them
// through this registry instead of a service the apps would each have to wire.
// Entries live exactly as long as their machine's scope.
const olderTurnRequestHandlers = new Map<string, () => void>();

/**
 * Asks the live state machine for `threadId` to fetch the next older page.
 * Returns false when no machine is live or no fetch was started (no cursor,
 * already loading); callers render from `EnvironmentThreadState.page` and can
 * treat false as "nothing to do".
 */
export function requestOlderThreadTurns(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): boolean {
  const handler = olderTurnRequestHandlers.get(threadKey({ environmentId, threadId }));
  if (handler === undefined) {
    return false;
  }
  handler();
  return true;
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
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
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    // A cached windowed snapshot restores its page cursor so "load earlier"
    // works while rendering from cache; a cached full snapshot has no page.
    page: Option.flatMap(cached, (snapshot) => pageStateFromSnapshot(snapshot.page)),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  // Bumped whenever loaded history may have been rewritten out from under an
  // in-flight older-page fetch (snapshot replacement, revert, deletion). A
  // page response captured under an older epoch is discarded, not merged.
  const historyEpoch = yield* Ref.make(0);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
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
    thread: OrchestrationThread,
    // "keep" preserves the current page state (live events touch only loaded
    // recent turns); a snapshot or merged page passes its own page state.
    page: Option.Option<EnvironmentThreadPageState> | "keep",
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.update(state, (current) => ({
      data: Option.some(thread),
      status: waiting ? ("synchronizing" as const) : ("live" as const),
      error: Option.none(),
      page: page === "keep" ? current.page : page,
    }));
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      const currentPage = yield* SubscriptionRef.get(state).pipe(Effect.map((value) => value.page));
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread,
        // Persist the window boundary with the window's content so a cache
        // restore can keep paging from where the loaded history ends.
        ...Option.match(currentPage, {
          onNone: () => ({}),
          onSome: (value) =>
            ({
              page: {
                beforeCursor: value.beforeCursor,
                hasMore: value.hasMore,
                snapshotSequence,
              },
            }) as const,
        }),
      });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      page: Option.none(),
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
    item: OrchestrationThreadStreamItem,
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
      // A fresh snapshot replaces all loaded history, including older pages:
      // a turn reverted while disconnected would otherwise survive in the
      // preserved history with no event left to remove it. The epoch bump
      // discards any older-page fetch racing this snapshot.
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread, pageStateFromSnapshot(item.snapshot.page));
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    // A revert rewrites loaded history (whole turns disappear), so an
    // older-page fetch in flight may straddle the removed range; discard it.
    if (item.event.type === "thread.reverted") {
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    }
    const result = applyThreadDetailEvent(current.data.value, item.event);
    if (result.kind === "updated") {
      yield* setThread(result.thread, "keep");
    } else if (result.kind === "deleted") {
      yield* setDeleted();
    }
  });

  // Merges an older disjoint page below the currently loaded window. All four
  // windowed collections prepend; identity dedupe guards the (server-bug or
  // cursor-misuse) case of overlapping pages so a row never renders twice.
  const mergeOlderPage = Effect.fn("EnvironmentThreadState.mergeOlderPage")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      return;
    }
    const loaded = current.data.value;
    const older = snapshot.thread;
    const mergeById = <T extends { readonly id: string }>(
      olderRows: ReadonlyArray<T>,
      loadedRows: ReadonlyArray<T>,
    ): ReadonlyArray<T> => {
      const seen = new Set(loadedRows.map((row) => row.id));
      return [...olderRows.filter((row) => !seen.has(row.id)), ...loadedRows];
    };
    const seenCheckpoints = new Set(loaded.checkpoints.map((row) => row.turnId));
    const merged: OrchestrationThread = {
      // Thread metadata stays the loaded (newer) snapshot's; only the
      // windowed collections gain rows from the older page.
      ...loaded,
      messages: mergeById(older.messages, loaded.messages),
      activities: mergeById(older.activities, loaded.activities),
      proposedPlans: mergeById(older.proposedPlans, loaded.proposedPlans),
      checkpoints: [
        ...older.checkpoints.filter((row) => !seenCheckpoints.has(row.turnId)),
        ...loaded.checkpoints,
      ],
    };
    yield* SubscriptionRef.update(state, (value) => ({
      ...value,
      data: Option.some(merged),
      page: pageStateFromSnapshot(snapshot.page),
    }));
    // Persist the widened window under the *loaded* watermark: the merged
    // content is only known consistent with the state it merged into, not
    // with the page's own (possibly newer) sequence.
    if (shouldPersistThread(merged)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread: merged,
        ...(snapshot.page === undefined ? {} : { page: { ...snapshot.page, snapshotSequence } }),
      });
    }
  });

  const loadOlderTurns = Effect.fn("EnvironmentThreadState.loadOlderTurns")(function* () {
    const current = yield* SubscriptionRef.get(state);
    const page = Option.getOrNull(current.page);
    if (page === null || page.loadingOlder || !page.hasMore || page.beforeCursor === null) {
      return;
    }
    const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
    if (prepared === null) {
      return;
    }
    const epochAtStart = yield* Ref.get(historyEpoch);
    yield* SubscriptionRef.update(state, (value) => ({
      ...value,
      page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: true })),
    }));
    const window: ThreadSnapshotWindow = {
      turnLimit: OLDER_THREAD_PAGE_USER_TURN_LIMIT,
      beforeCursor: page.beforeCursor,
    };
    const response = yield* snapshotLoader.load(prepared, threadId, window);
    const epochNow = yield* Ref.get(historyEpoch);
    const loadedSequence = yield* SubscriptionRef.get(lastSequence);
    // A page carrying a sequence older than the loaded state was read from a
    // projection behind what we render; merging it could resurrect turns a
    // newer snapshot or revert already removed.
    const stale =
      epochNow !== epochAtStart ||
      Option.match(response, {
        onNone: () => false,
        onSome: (snapshot) => snapshot.snapshotSequence < loadedSequence,
      });
    if (Option.isNone(response) || stale) {
      yield* SubscriptionRef.update(state, (value) => ({
        ...value,
        page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: false })),
      }));
      return;
    }
    yield* mergeOlderPage(response.value);
  });

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
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const config = yield* session.initialConfig.pipe(
          Effect.orElseSucceed(
            () =>
              ({}) as {
                threadResumeCompletionMarker?: boolean;
                threadSnapshotPagination?: boolean;
              },
          ),
        );
        const supportsCompletionMarker = config.threadResumeCompletionMarker === true;
        // Windowed loads are gated on the server capability: pre-pagination
        // servers reject unknown query params, and a windowed WS fallback to
        // such a server would silently hide history.
        const supportsPagination = config.threadSnapshotPagination === true;
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        if (Option.isNone(current.data) && current.status !== "deleted") {
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
          const httpSnapshot = yield* snapshotLoader.load(
            prepared,
            threadId,
            supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : undefined,
          );
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
            current = yield* SubscriptionRef.get(state);
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
          // The WS fallback snapshot (sent when afterSequence is missing or
          // the gap is too large) should be windowed the same as the HTTP
          // path; without this a resume failure re-downloads the full thread.
          ...(supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  // Expose loadOlderTurns to UI actions through the handler registry. Requests
  // funnel through a sliding queue drained serially, so mashing "load earlier"
  // coalesces (loadOlderTurns itself no-ops while a fetch is in flight).
  const olderTurnRequests = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(olderTurnRequests).pipe(
    Stream.runForEach(() => loadOlderTurns()),
    Effect.forkScoped,
  );
  const handlerKey = threadKey({ environmentId, threadId });
  const handler = () => {
    Queue.offerUnsafe(olderTurnRequests, undefined);
  };
  olderTurnRequestHandlers.set(handlerKey, handler);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      // Guard against a successor machine for the same thread having already
      // replaced the handler before this one's scope closes.
      if (olderTurnRequestHandlers.get(handlerKey) === handler) {
        olderTurnRequestHandlers.delete(handlerKey);
      }
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread)
              ? persist({
                  snapshotSequence,
                  thread,
                  ...Option.match(current.page, {
                    onNone: () => ({}),
                    onSome: (page) =>
                      ({
                        page: {
                          beforeCursor: page.beforeCursor,
                          hasMore: page.hasMore,
                          snapshotSequence,
                        },
                      }) as const,
                  }),
                })
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
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
