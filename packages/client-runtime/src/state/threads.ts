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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
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
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
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
const OLDER_THREAD_PAGE_USER_TURN_LIMIT = 20;

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

interface ThreadOlderTurnRequestRegistry {
  /**
   * Registers the live state machine for a thread. Returns the deregistration
   * cleanup; registration lives exactly as long as the machine's scope, and a
   * successor machine for the same thread simply replaces the entry.
   */
  readonly register: (key: string, handler: () => void) => () => void;
  readonly request: (key: string) => boolean;
}

function makeThreadOlderTurnRequestRegistry(): ThreadOlderTurnRequestRegistry {
  const handlers = new Map<string, () => void>();
  return {
    register: (key, handler) => {
      handlers.set(key, handler);
      return () => {
        if (handlers.get(key) === handler) {
          handlers.delete(key);
        }
      };
    },
    request: (key) => {
      const handler = handlers.get(key);
      if (handler === undefined) {
        return false;
      }
      handler();
      return true;
    },
  };
}

const defaultOlderTurnRequestRegistry = makeThreadOlderTurnRequestRegistry();

/**
 * Channel from UI actions to the live per-thread state machines. The machines
 * resolve it from the Effect environment (overridable in tests); the default
 * instance is shared with the sync `requestOlderThreadTurns` entry point so
 * the apps get working wiring without providing anything.
 */
class ThreadOlderTurnRequests extends Context.Reference<ThreadOlderTurnRequestRegistry>(
  "@t3tools/client-runtime/state/threads/ThreadOlderTurnRequests",
  { defaultValue: () => defaultOlderTurnRequestRegistry },
) {}

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
  return defaultOlderTurnRequestRegistry.request(threadKey({ environmentId, threadId }));
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

interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
}

interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  thread: OrchestrationThread | null,
  sequence: number,
  page: Pick<EnvironmentThreadPageState, "beforeCursor" | "hasMore"> | undefined,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== thread)
    return false;
  const currentPage = Option.getOrUndefined(current.state.page);
  return currentPage === undefined
    ? page === undefined
    : page !== undefined &&
        currentPage.beforeCursor === page.beforeCursor &&
        currentPage.hasMore === page.hasMore;
}

// A retained "live" state stays live: the cursor resume that follows only
// replays what the thread missed, and on servers that send the completion
// marker the first replayed event moves the status to "synchronizing" on its
// own. Downgrading here would flash a sync label on every return to a
// recently viewed thread.
function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status:
      value.status === "deleted" || (value.status === "live" && Option.isSome(value.data))
        ? value.status
        : statusWithoutLiveData(value.data),
    error: Option.none(),
    page: Option.map(value.page, (page) => ({ ...page, loadingOlder: false })),
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
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
              Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
            ),
          ),
        )
      : Option.none<OrchestrationThreadDetailSnapshot>();
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const initialState: EnvironmentThreadState = retained
    ? cachedThreadState(retained.state)
    : {
        data: cachedThread,
        status: statusWithoutLiveData(cachedThread),
        error: Option.none(),
        // A cached windowed snapshot restores its page cursor so "load earlier"
        // works while rendering from cache; a cached full snapshot has no page.
        page: Option.flatMap(cached, (snapshot) => pageStateFromSnapshot(snapshot.page)),
      };
  const state = yield* SubscriptionRef.make(initialState);
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
  };
  if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  const awaitingCompletion = yield* Ref.make(false);
  // Bumped whenever loaded history may have been rewritten out from under an
  // in-flight older-page fetch (snapshot replacement, revert, deletion). A
  // page response captured under an older epoch is discarded, not merged.
  const historyEpoch = yield* Ref.make(0);
  // Serializes stream-item application against older-page staleness checks +
  // merges. Without it, a revert or snapshot processed between loadOlderTurns'
  // epoch check and its merge could still slip resurrected history in.
  const applyLock = yield* Semaphore.make(1);
  // Save only completed data/cursor updates. A canceled scope must not cache
  // a cursor whose event has not reached the data yet.
  const remember = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const sequence = yield* SubscriptionRef.get(lastSequence);
    committed = {
      state: current,
      sequence,
      persisted:
        committed.persisted &&
        matchesThreadSnapshot(
          committed,
          Option.getOrNull(current.data),
          sequence,
          Option.getOrUndefined(current.page),
        ),
    };
    if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  });
  // Whether the connected server accepts windowed reads; set per subscription
  // from the session config. Gates loadOlderTurns so a reconnect to a
  // pre-pagination server never sends unsupported window parameters.
  const paginationSupported = yield* Ref.make(false);
  // An older page whose thread watermark is ahead of the live state, parked
  // until the subscription catches up (see mergeOlderPage's caller). At most
  // one can exist because loadOlderTurns no-ops while loadingOlder is true.
  const pendingOlderPage = yield* Ref.make<{
    readonly snapshot: OrchestrationThreadDetailSnapshot;
    readonly epoch: number;
  } | null>(null);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    if (
      committed.persisted &&
      matchesThreadSnapshot(committed, snapshot.thread, snapshot.snapshotSequence, snapshot.page)
    )
      return;
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (
            !matchesThreadSnapshot(
              committed,
              snapshot.thread,
              snapshot.snapshotSequence,
              snapshot.page,
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
    // The capability belongs to the session that advertised it. During a
    // reconnect, a new prepared connection can exist before the new session's
    // config arrives; leaving the old value would let loadOlderTurns send
    // window parameters to a server that may not accept them (review
    // finding). makeSubscribeInput re-sets it from the next session's config.
    yield* Ref.set(paginationSupported, false);
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

  // Body of applyItem, running under applyLock.
  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
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
      // A fresh snapshot replaces all loaded history, including older
      // pages: a turn reverted while disconnected would otherwise survive
      // in the preserved history with no event left to remove it. The
      // epoch bump discards any older-page fetch racing this snapshot.
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
    if (item.event.type === "thread.reverted") {
      // A revert rewrites loaded history (whole turns disappear), so an
      // older-page fetch in flight may straddle the removed range; the epoch
      // bump discards it. The stored page cursor stays valid: cursors are an
      // (anchor, turnId) keyset derived from event content, which survives
      // the revert projector's row rewrite, so no refresh is needed — the
      // revert reducer's turn filtering fully handles loaded history.
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    }
    const result = applyThreadDetailEvent(current.data.value, item.event);
    if (result.kind === "updated") {
      yield* setThread(result.thread, "keep");
    } else if (result.kind === "deleted") {
      yield* setDeleted();
    }
    // The event may have advanced the live state past a parked page's
    // watermark; merge it as soon as that happens.
    yield* tryMergePendingOlderPage();
  });

  // Merges a parked older page once the live state has caught up to the
  // page's thread watermark, or discards it if history was rewritten
  // (epoch advanced) while it waited. Must run under applyLock.
  const tryMergePendingOlderPage = Effect.fn("EnvironmentThreadState.tryMergePendingOlderPage")(
    function* () {
      const pending = yield* Ref.get(pendingOlderPage);
      if (pending === null) {
        return;
      }
      const epochNow = yield* Ref.get(historyEpoch);
      if (epochNow !== pending.epoch) {
        yield* Ref.set(pendingOlderPage, null);
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          page: Option.map(value.page, (existing) => ({ ...existing, loadingOlder: false })),
        }));
        return;
      }
      const watermark = pending.snapshot.page?.threadSequence;
      const loadedSequence = yield* SubscriptionRef.get(lastSequence);
      if (watermark !== undefined && watermark > loadedSequence) {
        return;
      }
      yield* Ref.set(pendingOlderPage, null);
      yield* mergeOlderPage(pending.snapshot);
    },
  );

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    yield* applyLock.withPermits(1)(applyItemLocked(item).pipe(Effect.andThen(remember)));
  });

  // Merges an older disjoint page below the currently loaded window. All four
  // windowed collections prepend; identity dedupe guards the (server-bug or
  // cursor-misuse) case of overlapping pages so a row never renders twice.
  const mergeOlderPage = Effect.fn("EnvironmentThreadState.mergeOlderPage")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    // The merge is built inside the update callback so it composes with
    // whatever thread value is current at commit time. The applyLock already
    // serializes this against event application; the atomic build is defense
    // in depth against future callers outside the lock.
    let merged: OrchestrationThread | null = null;
    yield* SubscriptionRef.update(state, (value) => {
      if (Option.isNone(value.data)) {
        return value;
      }
      const loaded = value.data.value;
      const older = snapshot.thread;
      const mergeById = <T extends { readonly id: string }>(
        olderRows: ReadonlyArray<T>,
        loadedRows: ReadonlyArray<T>,
      ): ReadonlyArray<T> => {
        const seen = new Set(loadedRows.map((row) => row.id));
        return [...olderRows.filter((row) => !seen.has(row.id)), ...loadedRows];
      };
      const seenCheckpoints = new Set(loaded.checkpoints.map((row) => row.turnId));
      merged = {
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
      return {
        ...value,
        data: Option.some(merged),
        page: pageStateFromSnapshot(snapshot.page),
      };
    });
    // Persist the widened window under the *loaded* watermark: the merged
    // content is only known consistent with the state it merged into, not
    // with the page's own (possibly newer) sequence.
    if (merged !== null && shouldPersistThread(merged)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, {
        snapshotSequence,
        thread: merged,
        ...(snapshot.page === undefined ? {} : { page: { ...snapshot.page, snapshotSequence } }),
      });
    }
    yield* remember;
  });

  const loadOlderTurns = Effect.fn("EnvironmentThreadState.loadOlderTurns")(function* () {
    // Gated on the connected server's capability: a reconnect to a
    // pre-pagination server must never receive window parameters.
    if (!(yield* Ref.get(paginationSupported))) {
      return;
    }
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
    // Staleness check and merge run under the same lock as stream-item
    // application, so a revert/snapshot cannot land between them (TOCTOU
    // review finding) — anything that rewrites history bumps the epoch
    // before this permit is acquired.
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        const epochNow = yield* Ref.get(historyEpoch);
        const loadedSequence = yield* SubscriptionRef.get(lastSequence);
        // A page carrying a sequence older than the loaded state was read
        // from a projection behind what we render; merging it could
        // resurrect turns a newer snapshot or revert already removed.
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
        // A page read AHEAD of the live state may include content (e.g.
        // streaming deltas of an out-of-window turn) the subscription has
        // not delivered yet; merging now and then replaying those events
        // would duplicate them. Park the page until the live state reaches
        // the page's thread-scoped watermark; loadingOlder stays true so
        // the UI shows progress and no second fetch starts. Pages from
        // pre-watermark servers (threadSequence absent) merge immediately,
        // preserving the old behavior.
        const watermark = response.value.page?.threadSequence;
        if (watermark !== undefined && watermark > loadedSequence) {
          yield* Ref.set(pendingOlderPage, {
            snapshot: response.value,
            epoch: epochNow,
          });
          return;
        }
        yield* mergeOlderPage(response.value);
      }),
    );
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

  // Only the first subscription after a warm live resume keeps the retained
  // status. A replacement session or foreground resubscribe on the same scope
  // may have missed events, so those show sync progress until confirmed.
  const resumingLive = yield* Ref.make(initialState.status === "live");
  const markSynchronizing = Effect.gen(function* () {
    if (yield* Ref.get(resumingLive)) return;
    yield* setSynchronizing;
  });

  yield* markSynchronizing;
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
        yield* Ref.set(paginationSupported, supportsPagination);
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* markSynchronizing;
        yield* Ref.set(resumingLive, false);

        let current = yield* SubscriptionRef.get(state);
        // A windowed cache resuming against a server without pagination is a
        // trap: afterSequence resume keeps only the window, and the missing
        // older turns can never be loaded (the server has no cursor reads).
        // Drop the window marker and treat the data as needing a full reload.
        if (!supportsPagination) {
          yield* applyLock.withPermits(1)(
            Effect.gen(function* () {
              if (Option.isNone((yield* SubscriptionRef.get(state)).page)) return;
              yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
              yield* SubscriptionRef.update(state, (value) => ({
                ...value,
                data: Option.none(),
                status: value.status === "deleted" ? value.status : ("empty" as const),
                page: Option.none(),
              }));
              yield* SubscriptionRef.set(lastSequence, 0);
              yield* remember;
            }),
          );
          current = yield* SubscriptionRef.get(state);
        }
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

  // Expose loadOlderTurns to UI actions through the request registry.
  // Requests funnel through a sliding queue drained serially, so mashing
  // "load earlier" coalesces (loadOlderTurns itself no-ops while a fetch is
  // in flight).
  const olderTurnRequestRegistry = yield* ThreadOlderTurnRequests;
  const olderTurnRequests = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(olderTurnRequests).pipe(
    Stream.runForEach(() => loadOlderTurns()),
    Effect.forkScoped,
  );
  const deregister = olderTurnRequestRegistry.register(
    threadKey({ environmentId, threadId }),
    () => {
      Queue.offerUnsafe(olderTurnRequests, undefined);
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(deregister));

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const { state: current, sequence: snapshotSequence } = committed;
      return Option.match(current.data, {
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
      });
    }),
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
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
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
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
