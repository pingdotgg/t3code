import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_PROJECTION: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};

type TestThreadInput = OrchestrationV2ThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  config?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      config?.completionMarker === true
        ? ({ threadResumeCompletionMarker: true } as never)
        : ({} as never),
    ),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationV2ThreadProjection;
  readonly cachedHistory?: {
    readonly historyCursor: string | null;
    readonly hasMoreHistory: boolean;
    readonly latestLocalTurnOrdinal?: number | null;
  };
  readonly httpSnapshot?: ThreadSnapshotLoadResult;
  readonly completionMarker?: boolean;
  readonly resumeCache?: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]>;
  readonly loadCached?: ReturnType<Persistence.EnvironmentCacheStore["Service"]["loadThread"]>;
  readonly saveThread?: Persistence.EnvironmentCacheStore["Service"]["saveThread"];
  readonly historyPaging?: "enabled" | "no-http" | "no-controller";
  readonly historyHttpClient?: HttpClient.HttpClient;
  readonly getTurnItem?: (input: {
    readonly itemId: TurnItemId;
  }) => Effect.Effect<{ readonly item: OrchestrationV2TurnItem | null }>;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make(false);
  const lastAcceptBoundedSnapshot = yield* Ref.make<true | undefined>(undefined);
  const lastAcceptCompactTurnItems = yield* Ref.make<true | undefined>(undefined);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: true;
      readonly acceptBoundedSnapshot?: true;
      readonly acceptCompactTurnItems?: true;
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(
            Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker === true),
          ),
          Effect.andThen(Ref.set(lastAcceptBoundedSnapshot, input.acceptBoundedSnapshot)),
          Effect.andThen(Ref.set(lastAcceptCompactTurnItems, input.acceptCompactTurnItems)),
          Effect.as(streamFrom(inputs)),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input: { readonly itemId: TurnItemId }) =>
      options?.getTurnItem?.(input) ?? Effect.die("Unexpected getTurnItem request"),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, options)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.as(
          threadId === THREAD_ID
            ? (options?.httpSnapshot ??
                ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult))
            : ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
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
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      options?.loadCached ??
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              projection: options.cached,
              ...(options.cachedHistory === undefined
                ? {}
                : {
                    historyCursor: options.cachedHistory.historyCursor,
                    hasMoreHistory: options.cachedHistory.hasMoreHistory,
                    ...(options.cachedHistory.latestLocalTurnOrdinal === undefined
                      ? {}
                      : {
                          latestLocalTurnOrdinal: options.cachedHistory.latestLocalTurnOrdinal,
                        }),
                  }),
            })
          : Option.none(),
      ),
    saveThread: (environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]).pipe(
        Effect.andThen(options?.saveThread?.(environmentId, thread) ?? Effect.void),
      ),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  let makeThreadState = makeEnvironmentThreadState(THREAD_ID, options?.resumeCache).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  if (options?.historyPaging !== "no-http") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        options?.historyHttpClient ??
          HttpClient.make(() => Effect.die("Unexpected history HTTP request")),
      ),
    );
  }
  const historyController = yield* ThreadHistoryController.ThreadHistoryController.pipe(
    Effect.provide(ThreadHistoryController.layer),
  );
  if (options?.historyPaging !== "no-controller") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(ThreadHistoryController.ThreadHistoryController, historyController),
    );
  }
  const threadState = yield* makeThreadState;
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    threadState,
    loadEarlier: (throughEntryId?: string) =>
      historyController.loadEarlier(TARGET.environmentId, THREAD_ID, throughEntryId),
    reconcilePendingWork: historyController.reconcilePendingWork(TARGET.environmentId, THREAD_ID),
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    loaderCalls,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    lastAcceptBoundedSnapshot,
    lastAcceptCompactTurnItems,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    wakeups,
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, options)),
    ),
  };
});

const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "snapshot" }> => ({
  kind: "snapshot",
  snapshotSequence,
  projection,
});

const synchronized = (): OrchestrationV2ThreadStreamItem => ({ kind: "synchronized" });

const titleUpdated = (title: string, sequence = 2): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-title"),
      type: "thread.metadata-updated",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, title, updatedAt: occurredAt },
    },
  };
};

const deleted = (sequence = 3): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T02:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-deleted"),
      type: "thread.deleted",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, updatedAt: occurredAt, deletedAt: occurredAt },
    },
  };
};

describe("EnvironmentThreads", () => {
  it.effect("loads the server thread when its local cache read fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        loadCached: Effect.fail(
          new Persistence.ConnectionPersistenceError({
            operation: "load-thread",
            message: "The database connection is closing.",
          }),
        ),
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
        },
      });

      const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(h.loaderCalls)).toBe(1);
      expect(yield* Ref.get(h.subscriptionCount)).toBe(1);
    }),
  );

  it.effect("flushes newer data after an older background write completes", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            cached: BASE_PROJECTION,
            saveThread: (_environmentId, snapshot) =>
              snapshot.snapshotSequence === 8
                ? Deferred.succeed(writing, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Deferred.succeed(written, undefined)),
                  )
                : Effect.void,
          });
          yield* Queue.offer(h.inputs, titleUpdated("First update", 8));
          yield* awaitThreadState(
            h.observed,
            (value) => Option.getOrNull(value.data)?.thread.title === "First update",
          );
          yield* TestClock.adjust("500 millis");
          yield* Deferred.await(writing);
          yield* Queue.offer(h.inputs, titleUpdated("Newer update", 9));
          yield* awaitThreadState(
            h.observed,
            (value) => Option.getOrNull(value.data)?.thread.title === "Newer update",
          );
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(written);
          return h.savedThreads;
        }),
      );
      expect(
        (yield* Ref.get(saved)).map((snapshot) => [
          snapshot.snapshotSequence,
          snapshot.projection.thread.title,
        ]),
      ).toEqual([
        [8, "First update"],
        [9, "Newer update"],
      ]);
    }),
  );

  it.effect("does not resume past a canceled event whose data was not applied", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const first = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            projection: BASE_PROJECTION,
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          },
        },
        resumeCache,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* awaitThreadState(first.observed, (value) => value.status === "live");
      const applying = yield* Deferred.make<void>();
      const update = titleUpdated("Not applied", 8);
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      let sequenceReads = 0;
      Object.defineProperty(update, "sequence", {
        get: () => {
          if (++sequenceReads === 2) Deferred.doneUnsafe(applying, Exit.void);
          return 8;
        },
      });
      yield* first.threadState.semaphore.take(1);
      yield* Queue.offer(first.inputs, update);
      yield* Deferred.await(applying);
      yield* Scope.close(scope, Exit.void);
      yield* first.threadState.semaphore.release(1);

      const resumed = yield* makeHarness({ resumeCache });
      const state = yield* awaitThreadState(resumed.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data).thread.title).toBe(BASE_PROJECTION.thread.title);
      expect(yield* Ref.get(resumed.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(first.savedThreads)).toEqual([
        {
          projection: BASE_PROJECTION,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: null,
        },
      ]);
    }),
  );

  it.effect("prevents an old scope from replacing its successor's cached data", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const oldScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const old = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache }).pipe(
        Effect.provideService(Scope.Scope, oldScope),
      );
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      yield* Queue.offer(old.inputs, titleUpdated("Old scope title", 8));
      yield* awaitThreadState(
        old.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Old scope title",
      );
      yield* Scope.close(oldScope, Exit.void);

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).thread.title).toBe(
        "Successor title",
      );
      expect(yield* Ref.get(old.savedThreads)).toEqual([]);
    }),
  );

  it.effect("does not let a delayed cache read replace an initialized successor", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const loading = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Option.Option<OrchestrationV2ThreadDetailSnapshot>>();
      const oldFiber = yield* makeHarness({
        resumeCache,
        loadCached: Deferred.succeed(loading, undefined).pipe(
          Effect.andThen(Deferred.await(response)),
        ),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(loading);
      const successor = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      yield* awaitThreadState(successor.observed, (value) => value.status === "live");
      yield* Deferred.succeed(
        response,
        Option.some({
          snapshotSequence: 3,
          projection: {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Old disk data" },
          },
        }),
      );
      const old = yield* Fiber.join(oldFiber);
      yield* awaitThreadState(old.observed, (value) => value.status === "live");

      expect(resumeCache.snapshot?.sequence).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).thread.title).toBe(
        BASE_PROJECTION.thread.title,
      );
    }),
  );

  it.effect("does not let an old deletion remove its successor's persisted cache", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const old = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      const update = deleted();
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      yield* Queue.offer(old.inputs, { ...update, sequence: 8 });
      yield* awaitThreadState(old.observed, (value) => value.status === "deleted");

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(yield* Ref.get(old.removedThreads)).toEqual([]);
    }),
  );

  it.effect("retains a deletion instead of restoring the old disk snapshot", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
          const update = deleted();
          if (update.kind !== "event") return yield* Effect.die("Expected an event");
          yield* Queue.offer(first.inputs, { ...update, sequence: 8 });
          yield* awaitThreadState(first.observed, (value) => value.status === "deleted");
        }),
      );
      const resumed = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      const state = yield* awaitThreadState(
        resumed.observed,
        (value) => value.status === "deleted",
      );
      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(resumed.loaderCalls)).toBe(0);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });

      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  describe("Stop on cached work the server already finished (#18188)", () => {
    const at = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const parentThreadId = ThreadId.make("thread:parent");
    const command = (
      id: string,
      status: "running" | "completed",
      exitCode?: number,
      ordinal = id === "older-command" ? 1 : 2,
    ): OrchestrationV2TurnItem => ({
      id: TurnItemId.make(id),
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status,
      title: null,
      startedAt: at,
      completedAt: status === "completed" ? at : null,
      updatedAt: at,
      type: "command_execution",
      input: `run ${id}`,
      output: "",
      ...(exitCode === undefined ? {} : { exitCode }),
    });
    const localRow = (item: OrchestrationV2TurnItem, position: number) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: THREAD_ID,
      sourceItemId: item.id,
      item,
    });
    // A fork's parent row keeps its own source; the child's Stop must not touch it.
    const inheritedRow = {
      position: 0,
      visibility: "inherited" as const,
      sourceThreadId: parentThreadId,
      sourceItemId: TurnItemId.make("cached-command"),
      item: { ...command("cached-command", "running"), threadId: parentThreadId },
    };
    const cachedProjection = (items: ReadonlyArray<OrchestrationV2TurnItem>) => ({
      ...BASE_PROJECTION,
      turnItems: items,
      visibleTurnItems: [inheritedRow, ...items.map((item, index) => localRow(item, index + 1))],
    });
    // Loaded older history the bounded window would drop, next to the stale item.
    const cached: OrchestrationV2ThreadProjection = cachedProjection([
      command("older-command", "completed", 0),
      command("cached-command", "running"),
    ]);
    const cachedHistory = { historyCursor: "older", hasMoreHistory: true };
    const projectionStatuses = (projection: OrchestrationV2ThreadProjection) => ({
      items: projection.turnItems.map((item) => [String(item.id), item.status]),
      rows: projection.visibleTurnItems.map((row) => [
        row.visibility,
        String(row.sourceItemId),
        row.item.status,
      ]),
      pending: pendingBackgroundTurnItems(projection).map((item) => String(item.id)),
    });
    const statuses = (state: EnvironmentThreadState) =>
      projectionStatuses(Option.getOrThrow(state.data));
    const settledStatuses = {
      items: [
        ["older-command", "completed"],
        ["cached-command", "completed"],
      ],
      rows: [
        ["inherited", "cached-command", "running"],
        ["local", "older-command", "completed"],
        ["local", "cached-command", "completed"],
      ],
      pending: [],
    };
    const serverItems = (items: Record<string, OrchestrationV2TurnItem | null>) => ({
      getTurnItem: ({ itemId }: { readonly itemId: TurnItemId }) =>
        Effect.succeed({ item: items[itemId] ?? null }),
    });

    it.effect("settles an item the server finished without any new event, keeping history", () =>
      Effect.gen(function* () {
        const written = yield* Deferred.make<OrchestrationV2ThreadDetailSnapshot>();
        const harness = yield* makeHarness({
          cached,
          cachedHistory,
          saveThread: (_environmentId, thread) => Deferred.succeed(written, thread),
          ...serverItems({ "cached-command": command("cached-command", "completed", 0) }),
        });
        const before = yield* SubscriptionRef.get(harness.threadState);

        yield* harness.reconcilePendingWork;

        const after = yield* SubscriptionRef.get(harness.threadState);
        expect(statuses(after)).toEqual(settledStatuses);
        const settled = Option.getOrThrow(after.data);
        expect(settled.visibleTurnItems[0]).toBe(inheritedRow);
        expect(settled.visibleTurnItems[2]!.item).toBe(settled.turnItems[1]);
        expect(after.history).toEqual(before.history);
        yield* TestClock.adjust("500 millis");
        const saved = yield* Deferred.await(written);
        expect(projectionStatuses(saved.projection)).toEqual(settledStatuses);
        expect(saved).toMatchObject({ historyCursor: "older", hasMoreHistory: true });
      }),
    );

    it.effect("saves the repair after older history was loaded, without the expansion", () =>
      Effect.gen(function* () {
        const evenOlder = command("even-older-command", "completed", 0, 0);
        const scope = yield* Scope.make();
        const harness = yield* makeHarness({
          cached,
          cachedHistory,
          historyHttpClient: HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
                  items: [localRow(evenOlder, 0)],
                  nextCursor: null,
                  hasMoreHistory: false,
                }),
              ),
            ),
          ),
          ...serverItems({ "cached-command": command("cached-command", "completed", 0) }),
        }).pipe(Scope.provide(scope));
        expect(yield* harness.loadEarlier()).toEqual({ _tag: "loaded" });
        expect((yield* SubscriptionRef.get(harness.threadState)).history.expanded).toBe(true);

        yield* harness.reconcilePendingWork;
        const after = yield* SubscriptionRef.get(harness.threadState);
        expect(after.history).toMatchObject({ expanded: true, historyCursor: null });
        expect(statuses(after).pending).toEqual([]);
        yield* TestClock.adjust("500 millis");
        yield* Scope.close(scope, Exit.void);

        const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
        expect(saved).toMatchObject({
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          historyCursor: "older",
          hasMoreHistory: true,
        });
        expect(projectionStatuses(saved!.projection)).toEqual(settledStatuses);

        const reloaded = yield* makeHarness({
          cached: saved!.projection,
          cachedHistory: { historyCursor: saved!.historyCursor!, hasMoreHistory: true },
        });
        expect(statuses(yield* SubscriptionRef.get(reloaded.threadState))).toEqual(settledStatuses);
      }),
    );

    const expandedHarness = Effect.fn("expandedHarness")(function* (
      scope: Scope.Closeable,
      options?: Pick<NonNullable<Parameters<typeof makeHarness>[0]>, "getTurnItem">,
    ) {
      const harness = yield* makeHarness({
        cached,
        cachedHistory,
        historyHttpClient: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
                items: [localRow(command("even-older-command", "completed", 0, 0), 0)],
                nextCursor: null,
                hasMoreHistory: false,
              }),
            ),
          ),
        ),
        ...serverItems({ "cached-command": command("cached-command", "completed", 0) }),
        ...options,
      }).pipe(Scope.provide(scope));
      return harness;
    });
    const expand = (harness: Effect.Success<ReturnType<typeof expandedHarness>>) =>
      Effect.gen(function* () {
        expect(yield* harness.loadEarlier()).toEqual({ _tag: "loaded" });
        expect((yield* SubscriptionRef.get(harness.threadState)).history.expanded).toBe(true);
      });
    const lastSaved = (harness: Effect.Success<ReturnType<typeof expandedHarness>>) =>
      Ref.get(harness.savedThreads).pipe(Effect.map((saved) => saved.at(-1)));

    it.effect("saves an expanded thread's repair when its scope closes before the save runs", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const harness = yield* expandedHarness(scope);
        yield* expand(harness);

        yield* harness.reconcilePendingWork;
        yield* Scope.close(scope, Exit.void);

        const saved = yield* lastSaved(harness);
        expect(saved).toMatchObject({ historyCursor: "older", hasMoreHistory: true });
        expect(projectionStatuses(saved!.projection)).toEqual(settledStatuses);
      }),
    );

    it.effect(
      "saves an expanded thread's repair when its scope closes during the save cooldown",
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const harness = yield* expandedHarness(scope);
          yield* Queue.offer(harness.inputs, titleUpdated("Renamed", CACHED_SNAPSHOT_SEQUENCE + 1));
          yield* awaitThreadState(
            harness.observed,
            (value) => Option.getOrThrow(value.data).thread.title === "Renamed",
          );
          yield* TestClock.adjust("500 millis");
          expect((yield* lastSaved(harness))?.projection.thread.title).toBe("Renamed");
          yield* expand(harness);

          yield* harness.reconcilePendingWork;
          yield* Scope.close(scope, Exit.void);

          const saved = yield* lastSaved(harness);
          expect(saved).toMatchObject({
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
            historyCursor: "older",
            hasMoreHistory: true,
          });
          expect(saved!.projection.thread.title).toBe("Renamed");
          expect(projectionStatuses(saved!.projection)).toEqual(settledStatuses);
        }),
    );

    it.effect("saves a completion event that lands while the server is asked", () =>
      Effect.gen(function* () {
        const asked = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<OrchestrationV2TurnItem>();
        const scope = yield* Scope.make();
        const harness = yield* expandedHarness(scope, {
          getTurnItem: () =>
            Deferred.succeed(asked, undefined).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.map((item) => ({ item })),
            ),
        });
        yield* expand(harness);
        const reconciling = yield* harness.reconcilePendingWork.pipe(Effect.forkChild);
        yield* Deferred.await(asked);
        const fromEvent = command("cached-command", "completed", 1);
        yield* Queue.offer(harness.inputs, {
          kind: "event",
          sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          event: {
            id: EventId.make("event-cached-command-completed"),
            type: "turn-item.updated",
            threadId: THREAD_ID,
            occurredAt: at,
            payload: fromEvent,
          },
        });
        yield* awaitThreadState(harness.observed, (value) =>
          Option.getOrThrow(value.data).turnItems.some(
            (item) => item.id === fromEvent.id && item.status === "completed",
          ),
        );

        yield* Deferred.succeed(answer, command("cached-command", "completed", 0));
        yield* Fiber.join(reconciling);
        yield* Scope.close(scope, Exit.void);

        const live = Option.getOrThrow((yield* SubscriptionRef.get(harness.threadState)).data);
        expect(live.turnItems.find((item) => item.id === fromEvent.id)).toEqual(fromEvent);
        const saved = yield* lastSaved(harness);
        expect(saved).toMatchObject({ historyCursor: "older", hasMoreHistory: true });
        expect(projectionStatuses(saved!.projection)).toEqual(settledStatuses);
        expect(saved!.projection.turnItems.find((item) => item.id === fromEvent.id)).toEqual(
          fromEvent,
        );
      }),
    );

    // The event is newer than any reply, so the saved copy follows it however the lookup ends.
    it.effect.each(["running", "missing", "timed out"] as const)(
      "saves a completion event that overtakes a %s lookup reply",
      (reply) =>
        Effect.gen(function* () {
          const asked = yield* Deferred.make<void>();
          const answer = yield* Deferred.make<void>();
          const scope = yield* Scope.make();
          const harness = yield* expandedHarness(scope, {
            getTurnItem: () =>
              Deferred.succeed(asked, undefined).pipe(
                Effect.andThen(reply === "timed out" ? Effect.never : Deferred.await(answer)),
                Effect.as({
                  item: reply === "running" ? command("cached-command", "running") : null,
                }),
              ),
          });
          yield* expand(harness);
          const reconciling = yield* harness.reconcilePendingWork.pipe(Effect.forkChild);
          yield* Deferred.await(asked);
          const fromEvent = command("cached-command", "completed", 1);
          yield* Queue.offer(harness.inputs, {
            kind: "event",
            sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
            event: {
              id: EventId.make("event-cached-command-completed"),
              type: "turn-item.updated",
              threadId: THREAD_ID,
              occurredAt: at,
              payload: fromEvent,
            },
          });
          yield* awaitThreadState(harness.observed, (value) =>
            Option.getOrThrow(value.data).turnItems.some(
              (item) => item.id === fromEvent.id && item.status === "completed",
            ),
          );

          if (reply === "timed out") yield* TestClock.adjust("10 seconds");
          else yield* Deferred.succeed(answer, undefined);
          yield* Fiber.join(reconciling);
          yield* Scope.close(scope, Exit.void);

          const saved = yield* lastSaved(harness);
          expect(saved).toMatchObject({ historyCursor: "older", hasMoreHistory: true });
          expect(projectionStatuses(saved!.projection)).toEqual(settledStatuses);
          expect(saved!.projection.turnItems.find((item) => item.id === fromEvent.id)).toEqual(
            fromEvent,
          );
        }),
    );

    it.effect("saves the repair for an expanded thread resumed in the same session", () =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: {
            state: {
              data: Option.some(cached),
              status: "cached",
              error: Option.none(),
              history: { ...EMPTY_THREAD_HISTORY_META, historyCursor: null, expanded: true },
            },
            sequence: CACHED_SNAPSHOT_SEQUENCE,
            persisted: true,
          },
          owner: undefined,
        };
        const scope = yield* Scope.make();
        const harness = yield* makeHarness({
          cached,
          cachedHistory,
          resumeCache,
          ...serverItems({ "cached-command": command("cached-command", "completed", 0) }),
        }).pipe(Scope.provide(scope));

        yield* harness.reconcilePendingWork;
        yield* TestClock.adjust("500 millis");
        yield* Scope.close(scope, Exit.void);

        const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
        expect(saved).toMatchObject({ historyCursor: "older", hasMoreHistory: true });
        expect(projectionStatuses(saved!.projection)).toEqual(settledStatuses);
      }),
    );

    it.effect("gives up on a lookup the server never answers, settling the rest", () =>
      Effect.gen(function* () {
        const askedCached = yield* Deferred.make<void>();
        const askedSilent = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          cached: cachedProjection([...cached.turnItems, command("silent-command", "running")]),
          cachedHistory,
          getTurnItem: ({ itemId }) =>
            itemId === "silent-command"
              ? Deferred.succeed(askedSilent, undefined).pipe(Effect.andThen(Effect.never))
              : Deferred.succeed(askedCached, undefined).pipe(
                  Effect.as({ item: command("cached-command", "completed", 0) }),
                ),
        });
        const reconciling = yield* harness.reconcilePendingWork.pipe(Effect.forkChild);
        yield* Deferred.await(askedCached);
        yield* Deferred.await(askedSilent);

        yield* TestClock.adjust("10 seconds");

        expect(reconciling.pollUnsafe()).toEqual(Exit.void);
        expect(statuses(yield* SubscriptionRef.get(harness.threadState)).items).toEqual([
          ["older-command", "completed"],
          ["cached-command", "completed"],
          ["silent-command", "running"],
        ]);
      }),
    );

    it.effect("keeps items the server still runs or does not return", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          cached: cachedProjection([...cached.turnItems, command("missing-command", "running")]),
          cachedHistory,
          ...serverItems({ "cached-command": command("cached-command", "running") }),
        });

        yield* harness.reconcilePendingWork;

        expect(statuses(yield* SubscriptionRef.get(harness.threadState)).items).toEqual([
          ["older-command", "completed"],
          ["cached-command", "running"],
          ["missing-command", "running"],
        ]);
      }),
    );

    it.effect("keeps events that land while the server is asked", () =>
      Effect.gen(function* () {
        const asked = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<OrchestrationV2TurnItem>();
        const harness = yield* makeHarness({
          cached,
          cachedHistory,
          getTurnItem: () =>
            Deferred.succeed(asked, undefined).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.map((item) => ({ item })),
            ),
        });
        const reconciling = yield* harness.reconcilePendingWork.pipe(Effect.forkChild);
        yield* Deferred.await(asked);
        yield* Queue.offer(harness.inputs, titleUpdated("Renamed", CACHED_SNAPSHOT_SEQUENCE + 1));
        yield* awaitThreadState(
          harness.observed,
          (value) => Option.getOrThrow(value.data).thread.title === "Renamed",
        );

        yield* Deferred.succeed(answer, command("cached-command", "completed", 0));
        yield* Fiber.join(reconciling);

        const after = yield* SubscriptionRef.get(harness.threadState);
        expect(Option.getOrThrow(after.data).thread.title).toBe("Renamed");
        expect(statuses(after)).toEqual(settledStatuses);
      }),
    );
  });

  it.effect("keeps progressive history metadata from a bounded socket fallback", () =>
    Effect.gen(function* () {
      const olderItem = {
        id: "item:older",
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        type: "command_execution",
        input: "pwd",
        output: "older history",
        exitCode: 0,
      };
      const harness = yield* makeHarness({
        historyHttpClient: HttpClient.make((request, url) => {
          expect(url.searchParams.get("cursor")).toBe("socket-history-cursor");
          expect(url.searchParams.get("throughEntryId")).toBe(olderItem.id);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                snapshotSequence: 14,
                items: [
                  {
                    position: 0,
                    visibility: "local",
                    sourceThreadId: THREAD_ID,
                    sourceItemId: olderItem.id,
                    item: olderItem,
                  },
                ],
                nextCursor: null,
                hasMoreHistory: false,
              }),
            ),
          );
        }),
      });
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshotSequence: 14,
        projection: BASE_PROJECTION,
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 47,
        payloadBudgetExceeded: false,
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" && value.history.historyCursor === "socket-history-cursor",
      );
      expect(state.history).toMatchObject({
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: 47,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.savedThreads)).at(-1)).toMatchObject({
        snapshotSequence: 14,
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 47,
      });
      expect(yield* harness.loadEarlier(olderItem.id)).toEqual({ _tag: "loaded" });
      const expanded = yield* SubscriptionRef.get(harness.threadState);
      expect(
        Option.getOrThrow(expanded.data).turnItems.some((item) => item.id === olderItem.id),
      ).toBe(true);
      expect(expanded.history.hasMoreHistory).toBe(false);
    }),
  );

  it.effect.each(["complete", "replacement snapshot", "retry"] as const)(
    "progressively reveals conversation history before activity, then handles %s",
    (mode) =>
      Effect.gen(function* () {
        const common = {
          threadId: THREAD_ID,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed",
          title: null,
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        };
        const message = {
          ...common,
          id: "item:older-message",
          ordinal: 1,
          type: "assistant_message",
          messageId: "message:older",
          text: "COD4 result",
          streaming: false,
        };
        const activity = {
          ...common,
          id: "item:older-command",
          ordinal: 2,
          type: "command_execution",
          input: "pwd",
          output: "",
          exitCode: 0,
        };
        const projected = (item: typeof message | typeof activity, position: number) => ({
          position,
          visibility: "local",
          sourceThreadId: THREAD_ID,
          sourceItemId: item.id,
          item,
        });
        const activityStarted = yield* Deferred.make<void>();
        const releaseActivity = yield* Deferred.make<void>();
        let activityRequests = 0;
        const harness = yield* makeHarness({
          historyHttpClient: HttpClient.make((request, url) =>
            Effect.gen(function* () {
              expect(url.searchParams.get("cursor")).toBe("progressive-cursor");
              const conversationOnly = url.searchParams.get("view") === "conversation";
              if (!conversationOnly && activityRequests++ === 0) {
                yield* Deferred.succeed(activityStarted, undefined);
                yield* Deferred.await(releaseActivity);
                if (mode === "retry")
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("Activity unavailable", { status: 503 }),
                  );
              }
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  snapshotSequence: 14,
                  items: conversationOnly
                    ? [projected(message, 0)]
                    : [projected(message, 0), projected(activity, 1)],
                  nextCursor: "next-cursor",
                  hasMoreHistory: true,
                }),
              );
            }),
          ),
        });
        yield* Queue.offer(harness.inputs, {
          ...snapshot(BASE_PROJECTION, 14),
          historyCursor: "progressive-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 47,
          payloadBudgetExceeded: false,
        });
        yield* awaitThreadState(
          harness.observed,
          (state) => state.history.historyCursor === "progressive-cursor",
        );
        const loading = yield* harness.loadEarlier(message.messageId).pipe(Effect.forkScoped);
        yield* Deferred.await(activityStarted);
        const preview = yield* SubscriptionRef.get(harness.threadState);
        expect(preview.history).toMatchObject({
          loading: true,
          historyCursor: "progressive-cursor",
          expanded: true,
        });
        expect(
          Option.getOrThrow(preview.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([message.id]);
        if (mode === "replacement snapshot") {
          yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION, 15));
          yield* awaitThreadState(
            harness.observed,
            (state) => state.history.historyCursor === null,
          );
        }
        yield* Deferred.succeed(releaseActivity, undefined);
        const result = yield* Fiber.join(loading);
        if (mode === "replacement snapshot") {
          expect(result).toEqual({ _tag: "noop" });
          const state = yield* SubscriptionRef.get(harness.threadState);
          expect(Option.getOrThrow(state.data).visibleTurnItems).toEqual(
            BASE_PROJECTION.visibleTurnItems,
          );
          expect(state.history.historyCursor).toBeNull();
          return;
        }
        if (mode === "retry") {
          expect(result._tag).toBe("error");
          expect(yield* harness.loadEarlier()).toEqual({ _tag: "loaded" });
        } else expect(result).toEqual({ _tag: "loaded" });
        const complete = yield* SubscriptionRef.get(harness.threadState);
        expect(complete.history).toMatchObject({
          loading: false,
          historyCursor: "next-cursor",
          error: null,
          latestLocalTurnOrdinal: 47,
        });
        expect(
          Option.getOrThrow(complete.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([message.id, activity.id]);
        expect(Option.getOrThrow(complete.data).turnItems).toHaveLength(2);
      }),
  );

  it.effect("restores compact socket snapshot turnItems before reducing and caching", () =>
    Effect.gen(function* () {
      const at = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
      const command = (id: string, ordinal: number, threadId = THREAD_ID) =>
        ({
          id: TurnItemId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed" as const,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "command_execution" as const,
          input: id,
          output: id,
          exitCode: 0,
        }) satisfies OrchestrationV2TurnItem;
      const parentThread = ThreadId.make("thread:compact-parent");
      const inherited = command("parent-item", 1, parentThread);
      const local = [command("local-1", 1), command("local-2", 2)];
      const retainedRequest = {
        ...command("retained-request", 0),
        type: "run_interrupt_request" as const,
        message: "Stop",
      } as unknown as OrchestrationV2TurnItem;
      const visibleTurnItems = [
        {
          position: 0,
          visibility: "inherited" as const,
          sourceThreadId: parentThread,
          sourceItemId: inherited.id,
          item: inherited,
        },
        ...local.map((item, index) => ({
          position: index + 1,
          visibility: "local" as const,
          sourceThreadId: THREAD_ID,
          sourceItemId: item.id,
          item,
        })),
      ];
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshotSequence: 5,
        projection: { ...BASE_PROJECTION, turnItems: [retainedRequest], visibleTurnItems },
        historyCursor: "compact-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 2,
        payloadBudgetExceeded: false,
        turnItemsOmitLocalVisible: true,
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) => value.history.historyCursor === "compact-cursor",
      );
      expect(Option.getOrThrow(seeded.data).turnItems).toEqual([...local, retainedRequest]);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
      expect(yield* Ref.get(harness.lastAcceptCompactTurnItems)).toBe(true);

      const updated = { ...local[1]!, output: "updated", ordinal: 2 };
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 6,
        event: {
          id: EventId.make("event-compact-update"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: at,
          payload: updated,
        },
      });
      const live = yield* awaitThreadState(harness.observed, (value) =>
        Option.exists(value.data, (data) =>
          data.turnItems.some(
            (item) => item.type === "command_execution" && item.output === "updated",
          ),
        ),
      );
      expect(Option.getOrThrow(live.data).turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "retained-request",
      ]);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "retained-request",
      ]);
      expect(saved && "turnItemsOmitLocalVisible" in saved).toBe(false);
    }),
  );

  it.effect("installs bounded snapshot history meta and resumes via afterSequence", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 11, projection: httpProjection },
          history: {
            historyCursor: "opaque-cursor",
            hasMoreHistory: true,
          },
        },
      });
      yield* Queue.offer(harness.inputs, titleUpdated("Live after bounded", 12));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live after bounded" &&
          value.history.hasMoreHistory,
      );

      expect(state.history).toMatchObject({
        historyCursor: "opaque-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(11);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
      expect(Option.getOrThrow(state.data).thread.title).toBe("Live after bounded");
    }),
  );

  it.effect("legacy warm cache without history meta stays complete (no false load-earlier)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      expect(state.history).toMatchObject({
        historyCursor: null,
        hasMoreHistory: false,
        expanded: false,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBeUndefined();
    }),
  );

  it.effect.each(["disk", "retained"] as const)(
    "retains paging support through a complete bounded %s cache",
    (cacheKind) =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const cold = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeHarness({
              resumeCache,
              httpSnapshot: {
                _tag: "present",
                snapshot: { snapshotSequence: 4, projection: BASE_PROJECTION },
                history: {
                  historyCursor: null,
                  hasMoreHistory: false,
                  latestLocalTurnOrdinal: null,
                },
              },
            });
            yield* Queue.offer(harness.inputs, titleUpdated("Complete bounded", 5));
            yield* awaitThreadState(
              harness.observed,
              (value) =>
                value.status === "live" &&
                Option.isSome(value.data) &&
                value.data.value.thread.title === "Complete bounded",
            );
            return harness;
          }),
        );
        const saved = (yield* Ref.get(cold.savedThreads)).at(-1);
        expect(saved).toMatchObject({
          snapshotSequence: 5,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: null,
        });

        const warm = yield* makeHarness(
          cacheKind === "retained"
            ? { resumeCache }
            : { loadCached: Effect.succeed(Option.some(saved!)) },
        );
        yield* Queue.offer(warm.inputs, titleUpdated("Grown while closed", 200));
        yield* awaitThreadState(
          warm.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Grown while closed",
        );
        expect(yield* Ref.get(warm.loaderCalls)).toBe(0);
        expect(yield* Ref.get(warm.lastSubscribeAfterSequence)).toBe(5);
        expect(yield* Ref.get(warm.lastAcceptBoundedSnapshot)).toBe(true);
      }),
  );

  it.effect("socket snapshot clears progressive history meta left from a bounded window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Warm progressive" },
        },
        cachedHistory: {
          historyCursor: "stale-cursor",
          hasMoreHistory: true,
        },
      });

      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Full socket snapshot" },
          },
          CACHED_SNAPSHOT_SEQUENCE + 1,
        ),
      );

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Full socket snapshot" &&
          value.history.historyCursor === null &&
          value.history.hasMoreHistory === false,
      );

      expect(state.history).toMatchObject({
        historyCursor: null,
        hasMoreHistory: false,
        expanded: false,
        loading: false,
        error: null,
      });

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.thread.title).toBe("Full socket snapshot");
      expect(saved?.historyCursor).toBeNull();
      expect(saved?.hasMoreHistory).toBe(false);
    }),
  );

  it.effect("installs and advances latestLocalTurnOrdinal for partial progressive windows", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 3,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Watermark seed" },
            },
            latestLocalTurnOrdinal: 15,
          },
          history: {
            historyCursor: "wm-cursor",
            hasMoreHistory: true,
            latestLocalTurnOrdinal: 15,
          },
        },
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Watermark seed" &&
          value.history.latestLocalTurnOrdinal === 15,
      );
      expect(seeded.history.latestLocalTurnOrdinal).toBe(15);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const savedSeed = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(savedSeed?.latestLocalTurnOrdinal).toBe(15);

      const newer = {
        id: TurnItemId.make("item-newer-live"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 22,
        status: "completed" as const,
        title: null,
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        type: "command_execution" as const,
        input: "echo newer",
        output: "newer",
        exitCode: 0,
      } satisfies OrchestrationV2TurnItem;

      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 4,
        event: {
          id: EventId.make("event-newer-item"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
          payload: newer,
        },
      });

      const advanced = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.history.latestLocalTurnOrdinal === 22 &&
          value.data.value.turnItems.some((item) => String(item.id) === String(newer.id)),
      );
      expect(advanced.history.latestLocalTurnOrdinal).toBe(22);
      expect(advanced.history.historyCursor).toBe("wm-cursor");
    }),
  );

  it.effect("falls back to the socket when the HTTP snapshot is only unavailable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "unavailable" },
      });

      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Socket title" },
        }),
      );

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Socket title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Socket title");
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
    }),
  );

  it.effect("does not recreate a deleted cache from a queued save or finalizer", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* TestClock.adjust("500 millis");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);

      yield* Queue.offer(harness.inputs, titleUpdated("Queued before deletion"));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.thread.title === "Queued before deletion",
      );
      yield* Queue.offer(harness.inputs, deleted());
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );
      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);

      yield* TestClock.adjust("10 seconds");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("keeps replayed updates synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Caught-up title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Caught-up title",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("Caught-up title");
    }),
  );

  it.effect("skips an unknown event type and resumes after it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      const unknown = (sequence: number): OrchestrationV2ThreadStreamItem => ({
        kind: "unknown-event",
        sequence,
        eventType: "run.from-a-future-server",
      });
      const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
      yield* Queue.offerAll(harness.inputs, [
        {
          kind: "event",
          sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          event: {
            id: EventId.make("event-message"),
            type: "message.updated",
            threadId: THREAD_ID,
            occurredAt,
            payload: {
              id: MessageId.make("message-before"),
              threadId: THREAD_ID,
              runId: null,
              nodeId: null,
              role: "assistant",
              text: "Before",
              streaming: false,
              attachments: [],
              createdBy: "agent",
              creationSource: "provider",
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
          },
        },
        unknown(CACHED_SNAPSHOT_SEQUENCE + 2),
        titleUpdated("After", CACHED_SNAPSHOT_SEQUENCE + 3),
        unknown(CACHED_SNAPSHOT_SEQUENCE + 4),
        synchronized(),
      ]);
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "After",
      );
      expect(Option.isNone(live.error)).toBe(true);
      expect(Option.getOrThrow(live.data).messages.map((message) => message.text)).toEqual([
        "Before",
      ]);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 4);
    }),
  );
});
