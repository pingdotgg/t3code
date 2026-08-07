import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type MessageId,
  type OrchestrationThread,
  type OrchestrationThreadHistoryPage,
  type OrchestrationThreadDeltaStreamItem,
  type OrchestrationThreadDetailPage,
  type OrchestrationThreadDetailSnapshot,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { ThreadHistoryCacheStore } from "../platform/threadHistoryCache.ts";
import { subscribeDynamicRequest } from "../rpc/client.ts";
import { THREAD_TURN_PAGE_SIZE, ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import {
  boundLiveThread,
  boundThreadHistoryPage,
  displayThreadHistory,
  mergeThreadHistoryPages,
} from "./threadHistory.ts";
import type { ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  followStreamInEnvironment,
} from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadHistoryState,
  type EnvironmentThreadPageState,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

export interface EnvironmentThreadStateOptions {
  readonly loadHistoryOutline?: boolean;
  readonly messagePagination?: {
    readonly enabled: () => boolean;
    readonly changes?: Stream.Stream<boolean>;
  };
}

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
export class ThreadOlderTurnRequests extends Context.Reference<ThreadOlderTurnRequestRegistry>(
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

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  options?: EnvironmentThreadStateOptions,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const historyCache = yield* ThreadHistoryCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const scope = yield* Scope.Scope;
  const environmentId = supervisor.target.environmentId;
  const cacheHistoryPage = Effect.fn("EnvironmentThreadState.cacheHistoryPage")(function* (
    page: OrchestrationThreadHistoryPage,
    writeToken: number,
  ) {
    yield* historyCache.save(environmentId, threadId, page, writeToken).pipe(
      Effect.catchTags({
        ConnectionPersistenceError: (error) =>
          Effect.logWarning("Could not persist cached thread history.").pipe(
            Effect.annotateLogs({
              environmentId,
              threadId,
              error: error.message,
            }),
          ),
      }),
    );
  });
  const clearHistoryCache = Effect.fn("EnvironmentThreadState.clearHistoryCache")(function* () {
    yield* historyCache.remove(environmentId, threadId).pipe(
      Effect.catchTags({
        ConnectionPersistenceError: (error) =>
          Effect.logWarning("Could not clear cached thread history.").pipe(
            Effect.annotateLogs({
              environmentId,
              threadId,
              error: error.message,
            }),
          ),
      }),
    );
  });
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
  const cachedThread = Option.map(cached, (snapshot) => boundLiveThread(snapshot.thread));
  const initiallyMessagePaginationEnabled = options?.messagePagination?.enabled() ?? false;
  const initiallyVisibleCachedThread = Option.filter(cachedThread, (thread) =>
    initiallyMessagePaginationEnabled
      ? thread.messageHistory !== undefined
      : thread.messageHistory === undefined,
  );
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: initiallyVisibleCachedThread,
    liveData: initiallyVisibleCachedThread,
    status: statusWithoutLiveData(initiallyVisibleCachedThread),
    error: Option.none(),
    history: { kind: "disabled" },
    // A cached windowed snapshot restores its page cursor so "load earlier"
    // works while rendering from cache; a cached full snapshot has no page.
    page: initiallyMessagePaginationEnabled
      ? Option.none()
      : Option.flatMap(cached, (snapshot) => pageStateFromSnapshot(snapshot.page)),
  });
  const liveThread = yield* Ref.make(cachedThread);
  const historyOutlineRefreshes = yield* SubscriptionRef.make(0);
  const threadSnapshotRefreshes = yield* SubscriptionRef.make(0);
  const messagePaginationSupported = yield* SubscriptionRef.make(false);
  const aroundLoadSemaphore = yield* Semaphore.make(1);
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<{
    readonly snapshot: OrchestrationThreadDetailSnapshot;
    readonly historyCacheWriteToken: number;
  }>(1);
  const preparedConnection = SubscriptionRef.get(supervisor.prepared).pipe(
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
  // Bumped whenever loaded history may have been rewritten out from under an
  // in-flight older-page fetch (snapshot replacement, revert, deletion). A
  // page response captured under an older epoch is discarded, not merged.
  const historyEpoch = yield* Ref.make(0);
  // Serializes stream-item application against older-page staleness checks +
  // merges. Without it, a revert or snapshot processed between loadOlderTurns'
  // epoch check and its merge could still slip resurrected history in.
  const applyLock = yield* Semaphore.make(1);
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

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (input: {
    readonly snapshot: OrchestrationThreadDetailSnapshot;
    readonly historyCacheWriteToken: number;
  }) {
    const { snapshot } = input;
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
    const firstMessage = snapshot.thread.messages[0];
    if (snapshot.thread.messageHistory !== undefined && firstMessage !== undefined) {
      yield* cacheHistoryPage(
        {
          messages: snapshot.thread.messages,
          activities: snapshot.thread.activities.filter(
            (activity) => activity.createdAt >= firstMessage.createdAt,
          ),
          proposedPlans: snapshot.thread.proposedPlans.filter(
            (plan) => plan.createdAt >= firstMessage.createdAt,
          ),
          messageHistory: snapshot.thread.messageHistory,
        },
        input.historyCacheWriteToken,
      );
    }
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
    yield* SubscriptionRef.set(messagePaginationSupported, false);
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
    const boundedThread = boundLiveThread(thread);
    yield* Ref.set(liveThread, Option.some(boundedThread));
    const waiting = yield* Ref.get(awaitingCompletion);
    const status: EnvironmentThreadStatus = waiting ? "synchronizing" : "live";
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      data: Option.some(displayThreadHistory(boundedThread, current.history)),
      liveData: Option.some(boundedThread),
      status,
      error: Option.none(),
      page: page === "keep" ? current.page : page,
    }));
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(boundedThread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      const historyCacheWriteToken = yield* historyCache.captureWriteToken();
      const currentPage = yield* SubscriptionRef.get(state).pipe(Effect.map((value) => value.page));
      yield* Queue.offer(persistence, {
        snapshot: {
          snapshotSequence,
          thread: boundedThread,
          ...Option.match(currentPage, {
            onNone: () => ({}),
            onSome: (value) => ({
              page: {
                beforeCursor: value.beforeCursor,
                hasMore: value.hasMore,
                snapshotSequence,
              },
            }),
          }),
        },
        historyCacheWriteToken,
      });
    }
  });

  let latestHistoryOutlineRequestId = 0;
  let historyOutlineLoading = false;
  const loadHistoryOutline = Effect.gen(function* () {
    if (options?.loadHistoryOutline === false) {
      return;
    }
    const current = yield* SubscriptionRef.get(state);
    if (current.history.kind === "disabled" || current.history.outline !== null) {
      return;
    }
    if (historyOutlineLoading) {
      return;
    }
    historyOutlineLoading = true;
    const requestId = ++latestHistoryOutlineRequestId;
    yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const outline = yield* snapshotLoader.loadHistoryOutline(prepared, threadId);
      if (Option.isNone(outline) || requestId !== latestHistoryOutlineRequestId) {
        return;
      }
      yield* SubscriptionRef.update(state, (latest) =>
        latest.history.kind === "disabled"
          ? latest
          : {
              ...latest,
              history: { ...latest.history, outline: outline.value },
            },
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (requestId === latestHistoryOutlineRequestId) {
            historyOutlineLoading = false;
          }
        }),
      ),
    );
  });

  const invalidateHistoryOutline = Effect.sync(() => {
    latestHistoryOutlineRequestId += 1;
    historyOutlineLoading = false;
  });

  let latestHistoryWindowRequestId = 0;
  const loadPreviousMessages = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const currentLiveThread = yield* Ref.get(liveThread);
    if (
      current.history.kind === "disabled" ||
      current.history.loading !== null ||
      Option.isNone(currentLiveThread)
    ) {
      return false;
    }
    const sourceHistory =
      current.history.window?.messageHistory ?? currentLiveThread.value.messageHistory;
    const cursor = sourceHistory?.cursor;
    if (
      sourceHistory === undefined ||
      !sourceHistory.hasMoreBefore ||
      cursor === null ||
      cursor === undefined
    ) {
      return false;
    }
    const requestId = ++latestHistoryWindowRequestId;
    const historyCacheWriteToken = yield* historyCache.captureWriteToken();

    const historyLookup = yield* historyCache
      .loadPrevious(environmentId, threadId, sourceHistory.startIndex, THREAD_TURN_PAGE_SIZE)
      .pipe(
        Effect.catchTags({
          ConnectionPersistenceError: (error) =>
            Effect.logWarning("Could not load cached previous thread messages.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as({
                page: Option.none<OrchestrationThreadHistoryPage>(),
                requestLimit: THREAD_TURN_PAGE_SIZE,
              }),
            ),
        }),
      );
    if (Option.isSome(historyLookup.page)) {
      const cachedPage = historyLookup.page.value;
      return yield* SubscriptionRef.modify(state, (latest) => {
        if (
          requestId !== latestHistoryWindowRequestId ||
          latest.history.kind === "disabled" ||
          latest.history.loading !== null ||
          Option.isNone(latest.liveData)
        ) {
          return [false, latest];
        }
        const latestLiveThread = latest.liveData.value;
        const liveMessages = latestLiveThread.messages;
        const firstLiveMessage = liveMessages[0];
        const currentWindow = latest.history.window ?? {
          messages: liveMessages,
          activities:
            firstLiveMessage === undefined
              ? []
              : latestLiveThread.activities.filter(
                  (activity) => activity.createdAt >= firstLiveMessage.createdAt,
                ),
          proposedPlans:
            firstLiveMessage === undefined
              ? []
              : latestLiveThread.proposedPlans.filter(
                  (plan) => plan.createdAt >= firstLiveMessage.createdAt,
                ),
          messageHistory: latestLiveThread.messageHistory ?? {
            hasMoreBefore: false,
            hasMoreAfter: false,
            startIndex: 0,
            endIndex: liveMessages.length,
            totalMessages: liveMessages.length,
            cursor: null,
          },
        };
        const window = boundThreadHistoryPage(
          mergeThreadHistoryPages({
            older: cachedPage,
            newer: currentWindow,
          }),
          "older",
        );
        const history: EnvironmentThreadHistoryState = { ...latest.history, window };
        return [
          true,
          {
            ...latest,
            data: Option.some(displayThreadHistory(latestLiveThread, history)),
            history,
          },
        ];
      });
    }

    const startedLoading = yield* SubscriptionRef.modify(state, (latest) => {
      if (
        requestId !== latestHistoryWindowRequestId ||
        latest.history.kind === "disabled" ||
        latest.history.loading !== null
      ) {
        return [false, latest];
      }
      const history: EnvironmentThreadHistoryState = {
        ...latest.history,
        loading: "before",
      };
      return [
        true,
        {
          ...latest,
          history,
        },
      ];
    });
    if (!startedLoading) {
      return false;
    }
    return yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const page = yield* snapshotLoader.loadPreviousMessages(
        prepared,
        threadId,
        cursor,
        historyLookup.requestLimit,
      );
      if (Option.isNone(page)) {
        return false;
      }

      const latest = yield* SubscriptionRef.get(state);
      const latestLiveThread = yield* Ref.get(liveThread);
      if (
        requestId !== latestHistoryWindowRequestId ||
        latest.history.kind === "disabled" ||
        latest.history.loading !== "before" ||
        Option.isNone(latestLiveThread)
      ) {
        return false;
      }
      const liveMessages = latestLiveThread.value.messages;
      const firstLiveMessage = liveMessages[0];
      const currentWindow = latest.history.window ?? {
        messages: liveMessages,
        activities:
          firstLiveMessage === undefined
            ? []
            : latestLiveThread.value.activities.filter(
                (activity) => activity.createdAt >= firstLiveMessage.createdAt,
              ),
        proposedPlans:
          firstLiveMessage === undefined
            ? []
            : latestLiveThread.value.proposedPlans.filter(
                (plan) => plan.createdAt >= firstLiveMessage.createdAt,
              ),
        messageHistory: latestLiveThread.value.messageHistory ?? {
          hasMoreBefore: false,
          hasMoreAfter: false,
          startIndex: 0,
          endIndex: liveMessages.length,
          totalMessages: liveMessages.length,
          cursor: null,
        },
      };
      const window = boundThreadHistoryPage(
        mergeThreadHistoryPages({
          older: page.value,
          newer: currentWindow,
        }),
        "older",
      );
      const history: EnvironmentThreadHistoryState = {
        ...latest.history,
        loading: null,
        window,
      };
      yield* SubscriptionRef.set(state, {
        ...latest,
        data: Option.some(displayThreadHistory(latestLiveThread.value, history)),
        history,
      });
      yield* Effect.forkIn(cacheHistoryPage(page.value, historyCacheWriteToken), scope);
      return true;
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) =>
          latest.history.kind === "ready" && latest.history.loading === "before"
            ? {
                ...latest,
                history: { ...latest.history, loading: null },
              }
            : latest,
        ),
      ),
    );
  });

  const loadNextMessages = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const currentLiveThread = yield* Ref.get(liveThread);
    const window = current.history.kind === "ready" ? current.history.window : null;
    const lastMessage = window?.messages.at(-1);
    if (
      current.history.kind === "disabled" ||
      current.history.loading !== null ||
      window === null ||
      !window.messageHistory.hasMoreAfter ||
      lastMessage === undefined ||
      Option.isNone(currentLiveThread)
    ) {
      return false;
    }
    const requestId = ++latestHistoryWindowRequestId;
    const historyCacheWriteToken = yield* historyCache.captureWriteToken();

    const historyLookup = yield* historyCache
      .loadNext(environmentId, threadId, window.messageHistory.endIndex, THREAD_TURN_PAGE_SIZE)
      .pipe(
        Effect.catchTags({
          ConnectionPersistenceError: (error) =>
            Effect.logWarning("Could not load cached next thread messages.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as({
                page: Option.none<OrchestrationThreadHistoryPage>(),
                requestLimit: THREAD_TURN_PAGE_SIZE,
              }),
            ),
        }),
      );
    if (Option.isSome(historyLookup.page)) {
      const cachedPage = historyLookup.page.value;
      return yield* SubscriptionRef.modify(state, (latest) => {
        if (
          requestId !== latestHistoryWindowRequestId ||
          latest.history.kind === "disabled" ||
          latest.history.loading !== null ||
          latest.history.window === null ||
          Option.isNone(latest.liveData)
        ) {
          return [false, latest];
        }
        const latestLiveThread = latest.liveData.value;
        const nextWindow = boundThreadHistoryPage(
          mergeThreadHistoryPages({
            older: latest.history.window,
            newer: cachedPage,
          }),
          "newer",
        );
        const history: EnvironmentThreadHistoryState = {
          ...latest.history,
          window: nextWindow,
        };
        return [
          true,
          {
            ...latest,
            data: Option.some(displayThreadHistory(latestLiveThread, history)),
            history,
          },
        ];
      });
    }

    const startedLoading = yield* SubscriptionRef.modify(state, (latest) => {
      if (
        requestId !== latestHistoryWindowRequestId ||
        latest.history.kind === "disabled" ||
        latest.history.loading !== null ||
        latest.history.window === null
      ) {
        return [false, latest];
      }
      const history: EnvironmentThreadHistoryState = {
        ...latest.history,
        loading: "after",
      };
      return [
        true,
        {
          ...latest,
          history,
        },
      ];
    });
    if (!startedLoading) {
      return false;
    }
    return yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const page = yield* snapshotLoader.loadNextMessages(
        prepared,
        threadId,
        {
          createdAt: lastMessage.createdAt,
          messageId: lastMessage.id,
        },
        historyLookup.requestLimit,
      );
      if (Option.isNone(page)) {
        return false;
      }

      const latest = yield* SubscriptionRef.get(state);
      const latestLiveThread = yield* Ref.get(liveThread);
      if (
        requestId !== latestHistoryWindowRequestId ||
        latest.history.kind === "disabled" ||
        latest.history.loading !== "after" ||
        latest.history.window === null ||
        Option.isNone(latestLiveThread)
      ) {
        return false;
      }
      const nextWindow = boundThreadHistoryPage(
        mergeThreadHistoryPages({
          older: latest.history.window,
          newer: page.value,
        }),
        "newer",
      );
      const history: EnvironmentThreadHistoryState = {
        ...latest.history,
        loading: null,
        window: nextWindow,
      };
      yield* SubscriptionRef.set(state, {
        ...latest,
        data: Option.some(displayThreadHistory(latestLiveThread.value, history)),
        history,
      });
      yield* Effect.forkIn(cacheHistoryPage(page.value, historyCacheWriteToken), scope);
      return true;
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) =>
          latest.history.kind === "ready" && latest.history.loading === "after"
            ? {
                ...latest,
                history: { ...latest.history, loading: null },
              }
            : latest,
        ),
      ),
    );
  });

  let latestAroundRequestId = 0;
  const loadMessagesAround = Effect.fn("EnvironmentThreadState.loadMessagesAround")(function* (
    messageId: MessageId,
  ) {
    latestHistoryWindowRequestId += 1;
    const requestId = ++latestAroundRequestId;
    return yield* Effect.gen(function* () {
      if (requestId !== latestAroundRequestId) {
        return false;
      }
      const historyCacheWriteToken = yield* historyCache.captureWriteToken();

      const current = yield* SubscriptionRef.get(state);
      if (current.history.kind === "disabled") {
        return false;
      }
      yield* SubscriptionRef.set(state, {
        ...current,
        history: { ...current.history, loading: "around" },
      });
      const cachedPage = yield* historyCache
        .loadAround(environmentId, threadId, messageId, THREAD_TURN_PAGE_SIZE)
        .pipe(
          Effect.catchTags({
            ConnectionPersistenceError: (error) =>
              Effect.logWarning("Could not load cached thread messages around the target.").pipe(
                Effect.annotateLogs({
                  environmentId,
                  threadId,
                  error: error.message,
                }),
                Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
              ),
          }),
        );
      const page = Option.isSome(cachedPage)
        ? cachedPage
        : yield* Effect.gen(function* () {
            const prepared = yield* preparedConnection;
            return yield* snapshotLoader.loadMessagesAround(prepared, threadId, messageId);
          });
      if (Option.isNone(page) || requestId !== latestAroundRequestId) {
        return false;
      }

      const latest = yield* SubscriptionRef.get(state);
      const latestLiveThread = yield* Ref.get(liveThread);
      if (
        latest.history.kind === "disabled" ||
        latest.history.loading !== "around" ||
        Option.isNone(latestLiveThread)
      ) {
        return false;
      }
      const totalMessages = Math.max(
        page.value.messageHistory.totalMessages,
        latestLiveThread.value.messageHistory?.totalMessages ??
          latestLiveThread.value.messages.length,
      );
      const window = Option.isSome(cachedPage)
        ? {
            ...page.value,
            messageHistory: {
              ...page.value.messageHistory,
              hasMoreAfter: page.value.messageHistory.endIndex < totalMessages,
              totalMessages,
            },
          }
        : page.value;
      const history: EnvironmentThreadHistoryState = {
        ...latest.history,
        window,
      };
      yield* SubscriptionRef.set(state, {
        ...latest,
        data: Option.some(displayThreadHistory(latestLiveThread.value, history)),
        history,
      });
      if (Option.isNone(cachedPage)) {
        yield* Effect.forkIn(cacheHistoryPage(page.value, historyCacheWriteToken), scope);
      }
      return true;
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) =>
          requestId === latestAroundRequestId &&
          latest.history.kind === "ready" &&
          latest.history.loading === "around"
            ? {
                ...latest,
                history: { ...latest.history, loading: null },
              }
            : latest,
        ),
      ),
      aroundLoadSemaphore.withPermit,
    );
  });

  const cancelMessagesAround = Effect.gen(function* () {
    latestAroundRequestId += 1;
    yield* SubscriptionRef.update(state, (current) =>
      current.history.kind === "ready" && current.history.loading === "around"
        ? {
            ...current,
            history: { ...current.history, loading: null },
          }
        : current,
    );
  });

  const showLatestMessages = Effect.gen(function* () {
    latestAroundRequestId += 1;
    latestHistoryWindowRequestId += 1;
    const current = yield* SubscriptionRef.get(state);
    const currentLiveThread = yield* Ref.get(liveThread);
    if (current.history.kind === "disabled" || Option.isNone(currentLiveThread)) {
      return false;
    }
    const history: EnvironmentThreadHistoryState = {
      ...current.history,
      window: null,
      loading: null,
    };
    yield* SubscriptionRef.set(state, {
      ...current,
      data: Option.some(displayThreadHistory(currentLiveThread.value, history)),
      history,
    });
    return true;
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* Ref.set(liveThread, Option.none());
    yield* clearHistoryCache();
    yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      liveData: Option.none(),
      status: "deleted",
      error: Option.none(),
      history: { kind: "disabled" },
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

  // Body of applyItem, running under applyLock.
  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationThreadDeltaStreamItem,
  ) {
    if (item.kind === "not-found") {
      yield* setDeleted();
      return;
    }

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
      yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
      if (item.snapshot.thread.messageHistory !== undefined) {
        // A bounded snapshot may replace an event replay, so cached segments
        // cannot be trusted to have survived an unseen revert.
        latestHistoryWindowRequestId += 1;
        latestAroundRequestId += 1;
        yield* clearHistoryCache();
        const current = yield* SubscriptionRef.get(state);
        const refreshOutline = current.history.kind === "ready";
        yield* invalidateHistoryOutline;
        yield* SubscriptionRef.update(state, (current) => {
          const history: EnvironmentThreadHistoryState =
            current.history.kind === "disabled"
              ? current.history
              : {
                  kind: "ready",
                  outline: null,
                  window: null,
                  loading: null,
                };
          return { ...current, history };
        });
        if (refreshOutline) {
          yield* SubscriptionRef.update(historyOutlineRefreshes, (revision) => revision + 1);
        }
      }
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread, pageStateFromSnapshot(item.snapshot.page));
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    const currentLiveThread = yield* Ref.get(liveThread);
    if (Option.isNone(currentLiveThread)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    const result = applyThreadDetailEvent(currentLiveThread.value, item.event);
    if (result.kind === "updated") {
      const sentUserMessage =
        item.event.type === "thread.message-sent" && item.event.payload.role === "user";
      if (item.event.type === "thread.reverted") {
        yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
        latestHistoryWindowRequestId += 1;
        latestAroundRequestId += 1;
        yield* clearHistoryCache();
        const current = yield* SubscriptionRef.get(state);
        const refreshOutline = current.history.kind === "ready";
        yield* invalidateHistoryOutline;
        yield* SubscriptionRef.update(state, (current) => {
          const history: EnvironmentThreadHistoryState =
            current.history.kind === "disabled"
              ? current.history
              : {
                  kind: "ready",
                  outline: null,
                  window: null,
                  loading: null,
                };
          return { ...current, history };
        });
        if (refreshOutline) {
          yield* SubscriptionRef.update(historyOutlineRefreshes, (revision) => revision + 1);
        }
      } else if (sentUserMessage) {
        // The event may come from another paired client. Local send handlers
        // own navigation to the live tail, so preserve this client's window.
        const current = yield* SubscriptionRef.get(state);
        const refreshOutline = current.history.kind === "ready";
        yield* invalidateHistoryOutline;
        yield* SubscriptionRef.update(state, (current) => {
          const history: EnvironmentThreadHistoryState =
            current.history.kind === "disabled"
              ? current.history
              : {
                  ...current.history,
                  outline: null,
                };
          return { ...current, history };
        });
        if (refreshOutline) {
          yield* SubscriptionRef.update(historyOutlineRefreshes, (revision) => revision + 1);
        }
      }
      yield* setThread(result.thread, "keep");
      if (
        item.event.type === "thread.reverted" &&
        (yield* SubscriptionRef.get(messagePaginationSupported))
      ) {
        yield* SubscriptionRef.update(threadSnapshotRefreshes, (revision) => revision + 1);
      }
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
    item: OrchestrationThreadDeltaStreamItem,
  ) {
    yield* applyLock.withPermits(1)(applyItemLocked(item));
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
    if (merged !== null) {
      yield* Ref.set(liveThread, Option.some(merged));
    }
    // Persist the widened window under the *loaded* watermark: the merged
    // content is only known consistent with the state it merged into, not
    // with the page's own (possibly newer) sequence.
    if (merged !== null && shouldPersistThread(merged)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      const historyCacheWriteToken = yield* historyCache.captureWriteToken();
      yield* Queue.offer(persistence, {
        snapshot: {
          snapshotSequence,
          thread: merged,
          ...(snapshot.page === undefined ? {} : { page: { ...snapshot.page, snapshotSequence } }),
        },
        historyCacheWriteToken,
      });
    }
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
  const snapshotResubscriptions = SubscriptionRef.changes(threadSnapshotRefreshes).pipe(
    Stream.filter((revision) => revision > 0),
  );
  const messagePaginationResubscriptions = options?.messagePagination?.changes ?? Stream.never;
  yield* SubscriptionRef.changes(historyOutlineRefreshes).pipe(
    Stream.filter((revision) => revision > 0),
    Stream.runForEach(() => loadHistoryOutline),
    Effect.forkScoped,
  );

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamicRequest(
      Effect.fn("EnvironmentThreadState.makeSubscriptionRequest")(function* (session) {
        const messagePaginationEnabled = options?.messagePagination?.enabled() ?? false;
        const subscriptionCapabilities = yield* session.initialConfig.pipe(
          Effect.map((config) => ({
            completionMarker: config.threadResumeCompletionMarker === true,
            messagePagination: messagePaginationEnabled && config.threadMessagePagination === true,
            snapshotPagination: config.threadSnapshotPagination === true,
            threadDeltaSubscription:
              config.environment?.capabilities.threadDeltaSubscription === true,
          })),
          Effect.orElseSucceed(() => ({
            completionMarker: false,
            messagePagination: false,
            snapshotPagination: false,
            threadDeltaSubscription: false,
          })),
        );
        const supportsCompletionMarker = subscriptionCapabilities.completionMarker;
        const supportsMessagePagination = subscriptionCapabilities.messagePagination;
        // Windowed loads are gated on the server capability: pre-pagination
        // servers reject unknown query params, and a windowed WS fallback to
        // such a server would silently hide history.
        const supportsPagination =
          !supportsMessagePagination && subscriptionCapabilities.snapshotPagination;
        yield* Ref.set(paginationSupported, supportsPagination);
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;
        const currentLiveThread = yield* Ref.get(liveThread);
        const visibleLiveThread = Option.filter(currentLiveThread, (thread) =>
          supportsMessagePagination
            ? thread.messageHistory !== undefined
            : thread.messageHistory === undefined,
        );
        if (Option.isSome(currentLiveThread) && Option.isNone(visibleLiveThread)) {
          yield* Ref.set(liveThread, Option.none());
        }
        yield* SubscriptionRef.update(state, (current) => {
          const history: EnvironmentThreadHistoryState = supportsMessagePagination
            ? current.history.kind === "ready"
              ? current.history
              : {
                  kind: "ready",
                  outline: null,
                  window: null,
                  loading: null,
                }
            : { kind: "disabled" };
          return {
            ...current,
            data: Option.map(visibleLiveThread, (thread) => displayThreadHistory(thread, history)),
            liveData: visibleLiveThread,
            history,
            page:
              supportsMessagePagination || Option.isNone(visibleLiveThread)
                ? Option.none()
                : current.page,
          };
        });

        let current = yield* SubscriptionRef.get(state);
        // A windowed cache resuming against a server without pagination is a
        // trap: afterSequence resume keeps only the window, and the missing
        // older turns can never be loaded (the server has no cursor reads).
        // Drop the window marker and treat the data as needing a full reload.
        if (!supportsPagination && Option.isSome(current.page)) {
          yield* Ref.update(historyEpoch, (epoch) => epoch + 1);
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            data: Option.none(),
            status: value.status === "deleted" ? value.status : ("empty" as const),
            page: Option.none(),
          }));
          yield* SubscriptionRef.set(lastSequence, 0);
          current = yield* SubscriptionRef.get(state);
        }
        if (Option.isNone(current.data) && current.status !== "deleted") {
          const prepared = yield* preparedConnection;
          const httpSnapshot = supportsMessagePagination
            ? yield* snapshotLoader.loadMessageHistory(prepared, threadId, THREAD_TURN_PAGE_SIZE)
            : yield* snapshotLoader.load(
                prepared,
                threadId,
                supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : undefined,
              );
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
            current = yield* SubscriptionRef.get(state);
          }
        }
        yield* SubscriptionRef.set(messagePaginationSupported, supportsMessagePagination);
        if (supportsMessagePagination) {
          yield* Effect.forkIn(loadHistoryOutline, scope);
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume =
          Option.isSome(current.data) &&
          (!supportsMessagePagination || current.data.value.messageHistory !== undefined);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          tag: subscriptionCapabilities.threadDeltaSubscription
            ? ORCHESTRATION_WS_METHODS.subscribeThreadWithDelta
            : ORCHESTRATION_WS_METHODS.subscribeThread,
          input: {
            threadId,
            ...(supportsMessagePagination ? { messageTurnLimit: THREAD_TURN_PAGE_SIZE } : {}),
            ...(supportsPagination ? { turnLimit: INITIAL_THREAD_USER_TURN_LIMIT } : {}),
            ...(canResume ? { afterSequence: sequence } : {}),
            ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          },
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: Stream.merge(
          foregroundResubscriptions,
          Stream.merge(snapshotResubscriptions, messagePaginationResubscriptions),
        ),
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
    Effect.all([
      Ref.get(liveThread),
      SubscriptionRef.get(lastSequence),
      SubscriptionRef.get(state),
    ]).pipe(
      Effect.flatMap(([currentLiveThread, snapshotSequence, current]) =>
        Option.match(currentLiveThread, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread)
              ? historyCache.captureWriteToken().pipe(
                  Effect.flatMap((historyCacheWriteToken) =>
                    persist({
                      snapshot: {
                        snapshotSequence,
                        thread,
                        ...Option.match(current.page, {
                          onNone: () => ({}),
                          onSome: (page) => ({
                            page: {
                              beforeCursor: page.beforeCursor,
                              hasMore: page.hasMore,
                              snapshotSequence,
                            },
                          }),
                        }),
                      },
                      historyCacheWriteToken,
                    }),
                  ),
                )
              : Effect.void,
        }),
      ),
    ),
  );

  return Object.assign(state, {
    loadPreviousMessages,
    loadNextMessages,
    loadMessagesAround,
    cancelMessagesAround,
    showLatestMessages,
  });
});

type EnvironmentThreadStateSubscription =
  SubscriptionRef.SubscriptionRef<EnvironmentThreadState> & {
    readonly loadPreviousMessages: Effect.Effect<boolean>;
    readonly loadNextMessages: Effect.Effect<boolean>;
    readonly loadMessagesAround: (messageId: MessageId) => Effect.Effect<boolean>;
    readonly cancelMessagesAround: Effect.Effect<void>;
    readonly showLatestMessages: Effect.Effect<boolean>;
  };

export function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  subscriptions?: Map<string, EnvironmentThreadStateSubscription>,
  options?: EnvironmentThreadStateOptions,
) {
  const key = threadKey({ environmentId, threadId });
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, options).pipe(
        Effect.flatMap((subscription) =>
          subscriptions === undefined
            ? Effect.succeed(SubscriptionRef.changes(subscription))
            : Effect.acquireRelease(
                Effect.sync(() => {
                  subscriptions.set(key, subscription);
                  return subscription;
                }),
                (registered) =>
                  Effect.sync(() => {
                    if (subscriptions.get(key) === registered) {
                      subscriptions.delete(key);
                    }
                  }),
              ).pipe(Effect.map(SubscriptionRef.changes)),
        ),
      ),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
  options?: EnvironmentThreadStateOptions,
) {
  const subscriptions = new Map<string, EnvironmentThreadStateSubscription>();
  const scheduler = createAtomCommandScheduler();
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId, subscriptions, options), {
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
    loadPreviousMessages: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-previous-messages",
      execute: (input: { readonly threadId: ThreadIdType }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.loadPreviousMessages ?? Effect.succeed(false);
          }),
        ),
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => threadKey({ environmentId, threadId: input.threadId }),
      },
    }),
    loadNextMessages: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-next-messages",
      execute: (input: { readonly threadId: ThreadIdType }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.loadNextMessages ?? Effect.succeed(false);
          }),
        ),
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => threadKey({ environmentId, threadId: input.threadId }),
      },
    }),
    showLatestMessages: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:show-latest-messages",
      execute: (input: { readonly threadId: ThreadIdType }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.showLatestMessages ?? Effect.succeed(false);
          }),
        ),
      scheduler,
      concurrency: { mode: "parallel" },
    }),
    cancelMessagesAround: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:cancel-messages-around",
      execute: (input: { readonly threadId: ThreadIdType }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.cancelMessagesAround ?? Effect.void;
          }),
        ),
      scheduler,
      concurrency: { mode: "parallel" },
    }),
    loadMessagesAround: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-messages-around",
      execute: (input: { readonly threadId: ThreadIdType; readonly messageId: MessageId }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.loadMessagesAround(input.messageId) ?? Effect.void;
          }),
        ),
      scheduler,
      concurrency: {
        mode: "parallel",
      },
    }),
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
