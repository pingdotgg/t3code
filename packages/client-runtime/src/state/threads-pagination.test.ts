import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import {
  INITIAL_THREAD_USER_TURN_LIMIT,
  makeEnvironmentThreadState,
  requestOlderThreadTurns,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

function message(id: string, turnId: string, createdAt: string): OrchestrationMessage {
  return {
    id: id as OrchestrationMessage["id"],
    role: "assistant",
    text: `text of ${id}`,
    turnId: TurnId.make(turnId),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

const OLDER_MESSAGE = message("message-old", "turn-1", "2026-04-01T00:00:00.000Z");
const RECENT_MESSAGE = message("message-recent", "turn-2", "2026-04-01T01:00:00.000Z");

// Reverts retain turns via checkpoints with checkpointTurnCount <= the revert's
// turnCount, so both fixture turns carry one: reverting to turnCount 1 keeps
// turn-1 (the older page's turn) and discards turn-2 (the loaded window's).
function checkpoint(turnId: string, turnCount: number): OrchestrationThread["checkpoints"][number] {
  return {
    turnId: TurnId.make(turnId),
    checkpointTurnCount: turnCount,
    checkpointRef:
      `checkpoint-${turnCount}` as OrchestrationThread["checkpoints"][number]["checkpointRef"],
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-04-01T01:00:00.000Z",
  };
}

const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Windowed thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [RECENT_MESSAGE],
  proposedPlans: [],
  activities: [],
  checkpoints: [checkpoint("turn-2", 2)],
  session: null,
};

const WINDOWED_SNAPSHOT: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 10,
  thread: BASE_THREAD,
  page: { beforeCursor: "cursor-1", hasMore: true, snapshotSequence: 10 },
};

const OLDER_PAGE: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 10,
  thread: {
    ...BASE_THREAD,
    messages: [OLDER_MESSAGE],
    checkpoints: [checkpoint("turn-1", 1)],
  },
  page: { beforeCursor: null, hasMore: false, snapshotSequence: 10 },
};

type LoaderResponse = Option.Option<OrchestrationThreadDetailSnapshot>;

const makeHarness = Effect.fn("TestThreadPagination.makeHarness")(function* (options?: {
  readonly paginationCapability?: boolean;
  readonly initialResponse?: LoaderResponse;
  /** Cached snapshot returned by the cache store (simulates a warm cache). */
  readonly cached?: OrchestrationThreadDetailSnapshot;
}) {
  const inputs = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const loaderWindows = yield* Ref.make<ReadonlyArray<ThreadSnapshotWindow | undefined>>([]);
  const lastSubscribeInput = yield* Ref.make<Record<string, unknown> | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  // Older-page responses resolve through deferreds so tests can interleave
  // live events with an in-flight page fetch.
  const pendingPageResponses = yield* Queue.unbounded<Deferred.Deferred<LoaderResponse>>();
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: Record<string, unknown>) =>
      Stream.unwrap(Ref.set(lastSubscribeInput, input).pipe(Effect.as(Stream.fromQueue(inputs)))),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      threadSnapshotPagination: options?.paginationCapability !== false,
    } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(session),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, _threadId, window) =>
      Ref.update(loaderWindows, (current) => [...current, window]).pipe(
        Effect.andThen(
          window?.beforeCursor === undefined
            ? Effect.succeed(
                options?.initialResponse ?? Option.none<OrchestrationThreadDetailSnapshot>(),
              )
            : Deferred.make<LoaderResponse>().pipe(
                Effect.tap((deferred) => Queue.offer(pendingPageResponses, deferred)),
                Effect.flatMap(Deferred.await),
              ),
        ),
      ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () =>
      Effect.succeed(options?.cached !== undefined ? Option.some(options.cached) : Option.none()),
    saveThread: (_environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) => Queue.offer(observed, state)),
    Effect.forkScoped,
  );

  const awaitState = (predicate: (state: EnvironmentThreadState) => boolean) =>
    Queue.take(observed).pipe(Effect.repeat({ until: predicate }));
  const resolveNextPage = (response: LoaderResponse) =>
    Queue.take(pendingPageResponses).pipe(
      Effect.flatMap((deferred) => Deferred.succeed(deferred, response)),
    );

  return {
    inputs,
    observed,
    awaitState,
    resolveNextPage,
    loaderWindows,
    lastSubscribeInput,
    savedThreads,
    threadState,
  };
});

const hasMessage = (state: EnvironmentThreadState, id: string): boolean =>
  Option.match(state.data, {
    onNone: () => false,
    onSome: (thread) => thread.messages.some((entry) => entry.id === id),
  });

const titleEvent = (title: string, sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-title-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:30:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:30:00.000Z",
    },
  },
});

// Reverting to turnCount 1 retains only turns whose checkpoint count is <= 1:
// turn-1 survives, turn-2 (the loaded window's newest turn) is discarded.
const revertEvent = (sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-revert-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.reverted",
    payload: {
      threadId: THREAD_ID,
      turnCount: 1,
    },
  },
});

describe("thread pagination state", () => {
  it.effect("windows the initial load when the server advertises pagination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      const state = yield* harness.awaitState((value) => Option.isSome(value.page));
      expect(Option.getOrThrow(state.page)).toEqual({
        beforeCursor: "cursor-1",
        hasMore: true,
        loadingOlder: false,
      });
      const windows = yield* Ref.get(harness.loaderWindows);
      expect(windows[0]?.turnLimit).toBe(INITIAL_THREAD_USER_TURN_LIMIT);
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBe(INITIAL_THREAD_USER_TURN_LIMIT);
    }),
  );

  it.effect("does not send a window to servers without the capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        paginationCapability: false,
        initialResponse: Option.some({ snapshotSequence: 10, thread: BASE_THREAD }),
      });
      const state = yield* harness.awaitState((value) => Option.isSome(value.data));
      expect(Option.isNone(state.page)).toBe(true);
      const windows = yield* Ref.get(harness.loaderWindows);
      expect(windows[0]).toBeUndefined();
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBeUndefined();
    }),
  );

  it.effect("merges an older page below the loaded window and clears the cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      expect(requestOlderThreadTurns(TARGET.environmentId, THREAD_ID)).toBe(true);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) => hasMessage(value, "message-old"));
      const thread = Option.getOrThrow(state.data);
      // Older rows land before the loaded window's rows.
      expect(thread.messages.map((entry) => entry.id)).toEqual(["message-old", "message-recent"]);
      expect(Option.getOrThrow(state.page)).toEqual({
        beforeCursor: null,
        hasMore: false,
        loadingOlder: false,
      });
    }),
  );

  it.effect("discards an in-flight older page when a revert rewrites history", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // Revert lands while the page fetch is in flight and removes turn-2.
      yield* Queue.offer(harness.inputs, revertEvent(11));
      yield* harness.awaitState((value) => !hasMessage(value, "message-recent"));
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      // The stale page was dropped: no resurrected rows, cursor unchanged.
      expect(hasMessage(state, "message-old")).toBe(false);
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
    }),
  );

  it.effect("discards an in-flight older page when a fresh snapshot replaces the thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 20,
          thread: { ...BASE_THREAD, title: "Replaced thread" },
          page: { beforeCursor: "cursor-2", hasMore: true, snapshotSequence: 20 },
        },
      });
      yield* harness.awaitState((value) =>
        Option.match(value.data, {
          onNone: () => false,
          onSome: (thread) => thread.title === "Replaced thread",
        }),
      );
      yield* harness.resolveNextPage(Option.some(OLDER_PAGE));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      expect(hasMessage(state, "message-old")).toBe(false);
      // The replacement snapshot's cursor wins over the discarded page's.
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-2");
    }),
  );

  it.effect("discards an older page read from a projection behind the loaded state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      yield* harness.resolveNextPage(Option.some({ ...OLDER_PAGE, snapshotSequence: 5 }));

      const state = yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => !page.loadingOlder }),
      );
      expect(hasMessage(state, "message-old")).toBe(false);
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
    }),
  );

  it.effect("a merged history page never advances the live-event dedupe sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // The page was captured at a newer projection sequence (12) than the
      // loaded state (10); merging it must not swallow events 11-12.
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 12,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 12 },
        }),
      );
      yield* harness.awaitState((value) => hasMessage(value, "message-old"));

      // Event at sequence 11 must still apply after the merge: the revert
      // discards turn-2, so the loaded window's row disappears while the
      // merged older turn-1 row survives. If the merge had advanced the
      // dedupe sequence to the page's 12, this event would be swallowed.
      yield* Queue.offer(harness.inputs, revertEvent(11));
      const state = yield* harness.awaitState(
        (value) => !hasMessage(value, "message-recent") && hasMessage(value, "message-old"),
      );
      expect(hasMessage(state, "message-old")).toBe(true);
    }),
  );

  it.effect("parks a page read ahead of the live state until events catch up", () =>
    Effect.gen(function* () {
      // A page whose thread watermark is ahead of the loaded state may
      // contain streaming content the subscription has not delivered yet
      // (e.g. an out-of-window subagent turn mid-stream); merging it
      // immediately and then replaying those deltas would duplicate text.
      // The page parks until the live state reaches the watermark.
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      requestOlderThreadTurns(TARGET.environmentId, THREAD_ID);
      yield* harness.awaitState((value) =>
        Option.match(value.page, { onNone: () => false, onSome: (page) => page.loadingOlder }),
      );
      // Page watermark 11 > loaded sequence 10: must park, not merge.
      yield* harness.resolveNextPage(
        Option.some({
          ...OLDER_PAGE,
          snapshotSequence: 11,
          page: { beforeCursor: null, hasMore: false, snapshotSequence: 11, threadSequence: 11 },
        }),
      );

      // A live event at sequence 11 arrives; only then does the page merge.
      yield* Queue.offer(harness.inputs, titleEvent("Advanced past watermark", 11));
      const state = yield* harness.awaitState((value) => hasMessage(value, "message-old"));
      expect(hasMessage(state, "message-recent")).toBe(true);
      expect(Option.getOrThrow(state.page).loadingOlder).toBe(false);
    }),
  );

  it.effect("a revert keeps the page cursor and triggers no refresh fetch", () =>
    Effect.gen(function* () {
      // Cursors are an (anchor, turnId) keyset derived from event content, so
      // they survive the revert projector's row rewrite: the machine keeps
      // the stored cursor and performs no snapshot re-fetch. The revert
      // reducer's turn filtering alone handles loaded history.
      const harness = yield* makeHarness({ initialResponse: Option.some(WINDOWED_SNAPSHOT) });
      yield* harness.awaitState((value) => Option.isSome(value.page));

      yield* Queue.offer(harness.inputs, revertEvent(11));
      const state = yield* harness.awaitState((value) => !hasMessage(value, "message-recent"));

      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
      const windows = yield* Ref.get(harness.loaderWindows);
      // Only the initial load hit the loader — no post-revert refresh fetch.
      expect(windows.length).toBe(1);
    }),
  );

  it.effect("drops a windowed cache when the server lacks the pagination capability", () =>
    Effect.gen(function* () {
      // Resuming a windowed cache via afterSequence against a pre-pagination
      // server would render only the window forever with no way to load the
      // rest: the machine must discard the cache and take a full snapshot.
      const fullSnapshot: OrchestrationThreadDetailSnapshot = {
        snapshotSequence: 20,
        thread: { ...BASE_THREAD, title: "Full reload" },
      };
      const harness = yield* makeHarness({
        paginationCapability: false,
        cached: WINDOWED_SNAPSHOT,
        initialResponse: Option.some(fullSnapshot),
      });

      const state = yield* harness.awaitState((value) =>
        Option.match(value.data, {
          onNone: () => false,
          onSome: (thread) => thread.title === "Full reload",
        }),
      );
      expect(Option.isNone(state.page)).toBe(true);
      // The subscription resumed from the fresh full snapshot, not the
      // discarded windowed cache's watermark, and sent no window fields.
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput);
      expect(subscribeInput?.turnLimit).toBeUndefined();
      expect(subscribeInput?.afterSequence).toBe(20);
    }),
  );

  it.effect("keeps a windowed cache when the server supports pagination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: WINDOWED_SNAPSHOT });
      const state = yield* harness.awaitState((value) => Option.isSome(value.page));
      expect(Option.getOrThrow(state.page).beforeCursor).toBe("cursor-1");
      // Wait for the subscription (recorded when the WS method is invoked)
      // before asserting its input.
      const subscribeInput = yield* Ref.get(harness.lastSubscribeInput).pipe(
        Effect.repeat({ until: (input) => input !== undefined }),
      );
      expect(subscribeInput?.afterSequence).toBe(10);
    }),
  );
});
