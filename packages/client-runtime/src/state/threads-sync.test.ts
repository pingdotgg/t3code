import {
  EnvironmentId,
  EventId,
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
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

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
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";

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

function makeTurnItem(id: string, ordinal: number): OrchestrationV2TurnItem {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
  return {
    id: TurnItemId.make(id),
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: occurredAt,
    completedAt: occurredAt,
    updatedAt: occurredAt,
    type: "command_execution",
    input: `command-${ordinal}`,
    output: `output-${ordinal}`,
    exitCode: 0,
  };
}
type TestThreadInput = OrchestrationV2ThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  config?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: config?.completionMarker === true,
    } as never),
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
  readonly httpSnapshot?:
    | ThreadSnapshotLoadResult
    | ((loaderCall: number) => ThreadSnapshotLoadResult);
  readonly httpDelay?: Deferred.Deferred<void>;
  readonly completionMarker?: boolean;
  readonly refreshCachedThreadOnSubscribe?: boolean;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make(false);
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
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(
            Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker === true),
          ),
          Effect.as(streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, options)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      (options?.httpDelay === undefined ? Effect.void : Deferred.await(options.httpDelay)).pipe(
        Effect.andThen(Ref.updateAndGet(loaderCalls, (count) => count + 1)),
        Effect.map((loaderCall) => {
          if (threadId !== THREAD_ID) {
            return { _tag: "unavailable" } satisfies ThreadSnapshotLoadResult;
          }
          if (typeof options?.httpSnapshot === "function") {
            return options.httpSnapshot(loaderCall);
          }
          return (
            options?.httpSnapshot ?? ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult)
          );
        }),
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
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
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
    saveThread: (_environmentId, snapshot) =>
      Ref.update(savedThreads, (current) => [...current, snapshot]),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
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
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: Stream.fromQueue(wakeups),
        ...(options?.refreshCachedThreadOnSubscribe === true
          ? { refreshCachedThreadOnSubscribe: true }
          : {}),
      }),
    ),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    loaderCalls,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    wakeups,
    replaceSession: Effect.gen(function* () {
      yield* SubscriptionRef.set(supervisorSession, Option.none());
      yield* SubscriptionRef.update(
        supervisorState,
        (current): SupervisorConnectionState => ({
          ...current,
          desired: true,
          network: "online",
          phase: "connecting",
          stage: "synchronizing",
          generation: current.generation + 1,
        }),
      );
      yield* SubscriptionRef.set(supervisorSession, Option.some(testSession(client, options)));
      yield* SubscriptionRef.update(
        supervisorState,
        (current): SupervisorConnectionState => ({
          ...current,
          phase: "connected",
          stage: null,
        }),
      );
    }),
  };
});

const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): OrchestrationV2ThreadStreamItem => ({
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
  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });

      // The warm cache reaches live from the cached data, and a live event
      // applies on top of it.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      // The subscription resumed from the cached sequence and never fetched the
      // full snapshot over HTTP.
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect(
    "refreshes a warm mobile cache with a bounded snapshot without blocking subscribe",
    () =>
      Effect.gen(function* () {
        const boundedProjection: OrchestrationV2ThreadProjection = {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Fresh bounded mobile thread" },
        };
        const harness = yield* makeHarness({
          cached: BASE_PROJECTION,
          completionMarker: true,
          refreshCachedThreadOnSubscribe: true,
          httpSnapshot: {
            _tag: "present",
            snapshot: { snapshotSequence: 21, projection: boundedProjection },
            history: {
              historyCursor: "mobile-open-cursor",
              hasMoreHistory: true,
            },
          },
        });

        const catchingUp = yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "synchronizing" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Fresh bounded mobile thread",
        );
        expect(catchingUp.status).toBe("synchronizing");
        yield* Queue.offer(harness.inputs, synchronized());
        const state = yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Fresh bounded mobile thread",
        );

        expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThanOrEqual(1);
        expect(state.history).toMatchObject({
          historyCursor: "mobile-open-cursor",
          hasMoreHistory: true,
          expanded: false,
        });
      }),
  );

  it.effect("resumes a warm cache on the socket while a delayed HTTP refresh is in flight", () =>
    Effect.gen(function* () {
      const httpDelay = yield* Deferred.make<void>();
      const refreshedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP catch-up" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpDelay,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 30, projection: refreshedProjection },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).thread.title).toBe(
        BASE_PROJECTION.thread.title,
      );
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Socket catch-up", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Socket catch-up",
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Socket catch-up",
      );

      yield* Deferred.succeed(httpDelay, undefined);
      const httpLive = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "HTTP catch-up",
      );
      expect(httpLive.history.historyCursor).toBeNull();
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
    }),
  );

  it.effect("installs a socket snapshot while a delayed HTTP refresh is still in flight", () =>
    Effect.gen(function* () {
      const httpDelay = yield* Deferred.make<void>();
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded after hang" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpDelay,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 41, projection: boundedProjection },
          history: {
            historyCursor: "bounded-after-hang",
            hasMoreHistory: true,
          },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
        yield* Effect.yieldNow;
      }

      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Full socket snapshot" },
          },
          40,
        ),
      );
      const fromSocket = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Full socket snapshot",
      );
      expect(fromSocket.status).toBe("live");
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      yield* Deferred.succeed(httpDelay, undefined);
      const fromHttp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Bounded after hang",
      );
      expect(fromHttp.history.historyCursor).toBe("bounded-after-hang");
    }),
  );

  it.effect("discards a stale HTTP snapshot that would rewind lastSequence", () =>
    Effect.gen(function* () {
      const httpDelay = yield* Deferred.make<void>();
      const staleProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Stale HTTP rewind" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpDelay,
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
            projection: staleProjection,
          },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
        yield* Effect.yieldNow;
      }

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Socket newer title", CACHED_SNAPSHOT_SEQUENCE + 20),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Socket newer title",
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Socket newer title",
      );

      yield* Deferred.succeed(httpDelay, undefined);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.loaderCalls)) >= 1) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data).thread.title).toBe(
        "Socket newer title",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(
        CACHED_SNAPSHOT_SEQUENCE + 20,
      );
    }),
  );

  it.effect("resumes a mobile thread incrementally after a foreground probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        cachedHistory: {
          historyCursor: "cached-mobile-cursor",
          hasMoreHistory: true,
        },
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (yield* Ref.get(harness.subscriptionCount)) >= 1 &&
          (yield* Ref.get(harness.loaderCalls)) >= 1
        ) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);

      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect((yield* Ref.get(harness.latest)).history.historyCursor).toBe("cached-mobile-cursor");
    }),
  );

  it.effect("accepts a full socket snapshot as authoritative for the current mobile session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (yield* Ref.get(harness.subscriptionCount)) >= 1 &&
          (yield* Ref.get(harness.loaderCalls)) >= 1
        ) {
          break;
        }
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);

      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Authoritative socket snapshot" },
          },
          40,
        ),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Authoritative socket snapshot",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(40);
    }),
  );

  it.effect("keeps a bounded mobile window when socket resume returns a full snapshot", () =>
    Effect.gen(function* () {
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded mobile window" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 41, projection: boundedProjection },
          history: {
            historyCursor: "bounded-mobile-cursor",
            hasMoreHistory: true,
          },
        },
      });

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Full socket snapshot" },
          },
          40,
        ),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.loaderCalls)) >= 2) break;
        yield* Effect.yieldNow;
      }
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.history.historyCursor === "bounded-mobile-cursor",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Bounded mobile window");
      expect(state.history).toMatchObject({
        historyCursor: "bounded-mobile-cursor",
        hasMoreHistory: true,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);
      const resumeSequence = yield* Ref.get(harness.lastSubscribeAfterSequence);
      // HTTP 41 can win and resubscribe from that cursor, or the socket
      // snapshot can clear catch-up first and leave the cache resume.
      expect(resumeSequence === CACHED_SNAPSHOT_SEQUENCE || resumeSequence === 41).toBe(true);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.projection.thread.title).toBe(
        "Live title",
      );
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(2);
    }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 1, projection: httpProjection },
        },
      });
      // No socket snapshot is pushed; only a live event arrives over the socket.
      // It can only be applied if the HTTP snapshot already seeded the thread.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      // Cold cache: the full snapshot was loaded over HTTP and the socket
      // resumed from that snapshot's sequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
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
      // Bounded HTTP success must not require a socket snapshot frame.
      expect(Option.getOrThrow(state.data).thread.title).toBe("Live after bounded");
    }),
  );

  it.effect("persists progressive history meta with a settled bounded snapshot", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded cache title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 4, projection: httpProjection },
          history: {
            historyCursor: "cursor-oldest",
            hasMoreHistory: true,
          },
        },
      });
      // Bounded install alone (settled) must enqueue progressive meta with the
      // projection. Never persist the partial window as a complete full snapshot.
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Bounded cache title" &&
          value.history.historyCursor === "cursor-oldest",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      const savedAll = yield* Ref.get(harness.savedThreads);
      expect(savedAll.length).toBeGreaterThanOrEqual(1);
      const first = savedAll[0];
      expect(first?.snapshotSequence).toBe(4);
      expect(first?.projection.thread.title).toBe("Bounded cache title");
      expect(first?.historyCursor).toBe("cursor-oldest");
      expect(first?.hasMoreHistory).toBe(true);
      // No earlier complete-looking entry without progressive meta.
      expect(
        savedAll.some(
          (entry) =>
            entry.projection.thread.title === "Bounded cache title" &&
            entry.historyCursor === undefined &&
            entry.hasMoreHistory === undefined,
        ),
      ).toBe(false);

      // A later live update still carries the progressive cursor.
      yield* Queue.offer(harness.inputs, titleUpdated("Settled bounded", 5));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Settled bounded",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.snapshotSequence).toBe(5);
      expect(saved?.projection.thread.title).toBe("Settled bounded");
      expect(saved?.historyCursor).toBe("cursor-oldest");
      expect(saved?.hasMoreHistory).toBe(true);
    }),
  );

  it.effect("warm resume restores progressive history meta and skips HTTP", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Cached bounded" },
        },
        cachedHistory: {
          historyCursor: "warm-cursor",
          hasMoreHistory: true,
        },
      });

      // Apply a live event so the subscription is known to have resumed from cache.
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Cached bounded live", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Cached bounded live" &&
          value.history.hasMoreHistory,
      );

      expect(state.history).toMatchObject({
        historyCursor: "warm-cursor",
        hasMoreHistory: true,
        expanded: false,
      });
      // Warm progressive cache must not re-download; resume via afterSequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
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

      // Settled full snapshot persistence must not keep the stale cursor.
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.thread.title).toBe("Full socket snapshot");
      expect(saved?.historyCursor).toBeUndefined();
      expect(saved?.hasMoreHistory).toBeUndefined();
    }),
  );

  it.effect("does not persist a mobile full socket snapshot before bounded HTTP", () =>
    Effect.gen(function* () {
      const httpDelay = yield* Deferred.make<void>();
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded cache after full snapshot" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpDelay,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 41, projection: boundedProjection },
          history: {
            historyCursor: "bounded-after-full",
            hasMoreHistory: true,
          },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Full socket snapshot" },
          },
          40,
        ),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Full socket snapshot",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect(
        (yield* Ref.get(harness.savedThreads)).some(
          (entry) =>
            entry.projection.thread.title === "Full socket snapshot" &&
            entry.historyCursor === undefined,
        ),
      ).toBe(false);

      yield* Deferred.succeed(httpDelay, undefined);
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.history.historyCursor === "bounded-after-full",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.thread.title).toBe("Bounded cache after full snapshot");
      expect(saved?.historyCursor).toBe("bounded-after-full");
      expect(saved?.hasMoreHistory).toBe(true);
    }),
  );

  it.effect("does not persist a mobile full socket snapshot when bounded HTTP overlaps it", () =>
    Effect.gen(function* () {
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded cache after overlap" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 41, projection: boundedProjection },
          history: {
            historyCursor: "bounded-overlap",
            hasMoreHistory: true,
          },
        },
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Full socket snapshot" },
          },
          40,
        ),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      const settled = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.history.historyCursor === "bounded-overlap",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect(Option.getOrThrow(settled.data).thread.title).toBe("Bounded cache after overlap");
      expect(
        (yield* Ref.get(harness.savedThreads)).some(
          (entry) =>
            entry.projection.thread.title === "Full socket snapshot" &&
            entry.historyCursor === undefined,
        ),
      ).toBe(false);
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.thread.title).toBe("Bounded cache after overlap");
      expect(saved?.historyCursor).toBe("bounded-overlap");
    }),
  );

  it.effect("live events preserve progressive history meta under atomic setThread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 8,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Bounded seed" },
            },
          },
          history: {
            historyCursor: "keep-me",
            hasMoreHistory: true,
          },
        },
      });

      yield* Queue.offer(harness.inputs, titleUpdated("Live preserves meta", 9));
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live preserves meta",
      );

      expect(state.history).toMatchObject({
        historyCursor: "keep-me",
        hasMoreHistory: true,
        expanded: false,
      });
    }),
  );

  it.effect("bounded HTTP install sets projection and progressive meta atomically", () =>
    Effect.gen(function* () {
      // One setThread with explicit history (not applyItem reset + later meta).
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 2,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Bounded atomic install" },
            },
          },
          history: {
            historyCursor: "post-install-cursor",
            hasMoreHistory: true,
          },
        },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Bounded atomic install" &&
          value.history.historyCursor === "post-install-cursor" &&
          value.history.hasMoreHistory === true,
      );

      expect(state.history).toMatchObject({
        historyCursor: "post-install-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(2);
    }),
  );

  it.effect("dropped partial-timeline turn item is a true applyItem no-op", () =>
    Effect.gen(function* () {
      const recent = {
        id: TurnItemId.make("item-window"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 10,
        status: "completed" as const,
        title: null,
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        type: "command_execution" as const,
        input: "pwd",
        output: "ok",
        exitCode: 0,
      } satisfies OrchestrationV2TurnItem;
      const recentRow = {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: THREAD_ID,
        sourceItemId: recent.id,
        item: recent,
      };
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Partial noop" },
        turnItems: [recent],
        visibleTurnItems: [recentRow],
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 5,
            projection: boundedProjection,
            latestLocalTurnOrdinal: 10,
          },
          history: {
            historyCursor: "partial-cursor",
            hasMoreHistory: true,
            latestLocalTurnOrdinal: 10,
          },
        },
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Partial noop" &&
          value.history.historyCursor === "partial-cursor",
      );
      const seededProjection = Option.getOrThrow(seeded.data);
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const savedBefore = (yield* Ref.get(harness.savedThreads)).length;

      const older = {
        ...recent,
        id: TurnItemId.make("item-old-outside"),
        ordinal: 3,
        output: "must-not-append",
      } satisfies OrchestrationV2TurnItem;
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 6,
        event: {
          id: EventId.make("event-old-partial"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
          payload: older,
        },
      });

      // Allow the event to be processed without requiring a state transition.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        yield* Effect.yieldNow;
      }
      // Drive a later unrelated title update so we know the stream continued.
      yield* Queue.offer(harness.inputs, titleUpdated("After dropped event", 7));
      const after = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "After dropped event",
      );

      // The dropped event must not have appended the old item.
      expect(Option.getOrThrow(after.data).turnItems.map((item) => String(item.id))).toEqual([
        String(recent.id),
      ]);
      // Watermark unchanged (only advanced on successful newer turn-item applies).
      expect(after.history.latestLocalTurnOrdinal).toBe(10);
      // No persistence enqueue from the dropped event itself.
      const savedAfterDrop = (yield* Ref.get(harness.savedThreads)).length;
      expect(savedAfterDrop).toBe(savedBefore);
      // Seeded projection reference path: event path kept partial meta intact.
      expect(after.history.historyCursor).toBe("partial-cursor");
      expect(after.history.hasMoreHistory).toBe(true);
      // Title event applied; drop itself did not clear progressive meta.
      expect(seededProjection.turnItems.map((item) => String(item.id))).toEqual([
        String(recent.id),
      ]);
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

  it.effect("warm resume restores latestLocalTurnOrdinal from progressive cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Warm watermark" },
        },
        cachedHistory: {
          historyCursor: "warm-wm-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 33,
        },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Warm watermark" &&
          value.history.latestLocalTurnOrdinal === 33,
      );
      expect(state.history).toMatchObject({
        historyCursor: "warm-wm-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 33,
        expanded: false,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("marks a cold definitive HTTP miss deleted without socket subscribe or retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "missing" },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(Option.isNone(state.error)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);

      // A definitive miss must not schedule the expected-failure retry path.
      yield* TestClock.adjust("1 second");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* harness.replaceSession;
      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect((yield* Ref.get(harness.latest)).status).toBe("deleted");
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

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
    }),
  );

  it.effect("does not persist a queued snapshot after the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      const savedBeforeDelete = (yield* Ref.get(harness.savedThreads)).length;
      yield* Queue.offer(harness.inputs, deleted());
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      expect((yield* Ref.get(harness.savedThreads)).length).toBe(savedBeforeDelete);
      expect((yield* Ref.get(harness.latest)).status).toBe("deleted");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("does not revive a deleted thread from a later socket snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, deleted());
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Stale snapshot" },
        }),
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        yield* Effect.yieldNow;
      }

      const state = yield* Ref.get(harness.latest);
      expect(state.status).toBe("deleted");
      expect(Option.isNone(state.data)).toBe(true);
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

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
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
          thread: { ...BASE_PROJECTION.thread, title: "Materialized thread" },
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("keeps an already-live thread live while the supervisor reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
      });
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Reconnect kept live data", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Reconnect kept live data",
      );
      expect(live.status).toBe("live");
    }),
  );

  it.effect("shows Syncing for a warm mobile cache until catch-up arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
      });
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );

      expect(Option.getOrThrow(catchingUp.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data)).toEqual(BASE_PROJECTION);
    }),
  );

  it.effect("keeps Syncing when the authoritative HTTP refresh is unavailable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: { _tag: "unavailable" },
      });
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );

      expect(Option.getOrThrow(catchingUp.data)).toEqual(BASE_PROJECTION);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.loaderCalls)) >= 1) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data)).toEqual(BASE_PROJECTION);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data)).toEqual(BASE_PROJECTION);
    }),
  );

  it.effect("keeps Syncing on the cached body until the socket snapshot arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
            projection: BASE_PROJECTION,
          },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.loaderCalls)) >= 1) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      expect(Option.getOrThrow((yield* Ref.get(harness.latest)).data)).toEqual(BASE_PROJECTION);

      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Latest socket content" },
          },
          40,
        ),
      );
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest socket content",
      );
      expect(live.status).toBe("live");
    }),
  );

  it.effect("returns a disconnected warm cache to live when the supervisor reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
      });
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: false,
        network: "offline",
        phase: "offline",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* awaitThreadState(harness.observed, (value) => value.status === "cached");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 2,
        lastFailure: null,
        retryAt: null,
      });
      const live = yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      expect(Option.isSome(live.data)).toBe(true);
    }),
  );

  it.effect("keeps replayed updates synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ completionMarker: true });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isNone(value.data),
      );
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Caught-up title", 2));
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

  it.effect("keeps a cold HTTP seed synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP seed" },
      };
      const harness = yield* makeHarness({
        completionMarker: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 1, projection: httpProjection },
        },
      });
      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.thread.title === "HTTP seed",
      );
      expect(seeded.status).toBe("synchronizing");
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(harness.inputs, titleUpdated("After HTTP seed", 2));
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.thread.title === "After HTTP seed",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "After HTTP seed",
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("After HTTP seed");
    }),
  );

  it.effect("keeps a cold HTTP seed synchronizing across supervisor reconnect", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP seed" },
      };
      const harness = yield* makeHarness({
        completionMarker: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 1, projection: httpProjection },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.thread.title === "HTTP seed",
      );

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("HTTP seed");
    }),
  );

  it.effect("keeps a cold HTTP seed synchronizing across a session remake", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP seed" },
      };
      const harness = yield* makeHarness({
        completionMarker: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 1, projection: httpProjection },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.thread.title === "HTTP seed",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("HTTP seed");
    }),
  );

  it.effect("keeps a cold HTTP seed synchronizing across an application-active remake", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP seed" },
      };
      const harness = yield* makeHarness({
        completionMarker: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 1, projection: httpProjection },
        },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.thread.title === "HTTP seed",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("HTTP seed");
    }),
  );

  it.effect("resumes replacement sessions from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("resumes desktop foreground from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("Latest title");
    }),
  );

  it.effect("retains bounded mobile history across a foreground probe", () =>
    Effect.gen(function* () {
      const oldItem = makeTurnItem("item-before-bounded-window", 1);
      const latestItem = makeTurnItem("item-inside-bounded-window", 10);
      const cachedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        turnItems: [oldItem, latestItem],
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: THREAD_ID,
            sourceItemId: oldItem.id,
            item: oldItem,
          },
          {
            position: 1,
            visibility: "local",
            sourceThreadId: THREAD_ID,
            sourceItemId: latestItem.id,
            item: latestItem,
          },
        ],
      };
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        turnItems: [latestItem],
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: THREAD_ID,
            sourceItemId: latestItem.id,
            item: latestItem,
          },
        ],
      };
      const harness = yield* makeHarness({
        cached: cachedProjection,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 20,
            projection: boundedProjection,
            latestLocalTurnOrdinal: 10,
          },
          history: {
            historyCursor: "bounded-mobile-cursor",
            hasMoreHistory: true,
            latestLocalTurnOrdinal: 10,
          },
        },
      });
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
        yield* Effect.yieldNow;
      }

      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      const refreshed = yield* Ref.get(harness.latest);

      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(20);
      expect(refreshed.history).toEqual({
        historyCursor: "bounded-mobile-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: 10,
      });
      expect(Option.getOrThrow(refreshed.data).turnItems.map((item) => item.id)).toEqual([
        latestItem.id,
      ]);
      expect(
        Option.getOrThrow(refreshed.data).visibleTurnItems.map((row) => row.sourceItemId),
      ).toEqual([latestItem.id]);

      expect(refreshed.status).toBe("live");
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
    }),
  );

  it.effect("keeps an already-live thread live across a foreground probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
      });
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect((yield* Ref.get(harness.latest)).status).toBe("live");

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Foreground stream resumed", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Foreground stream resumed",
      );

      expect(live.status).toBe("live");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
    }),
  );

  it.effect("shows Syncing and refreshes a retained thread after a long-background reconnect", () =>
    Effect.gen(function* () {
      const reconnectProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Reconnect HTTP catch-up" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: (loaderCall) =>
          loaderCall === 1
            ? {
                _tag: "present" as const,
                snapshot: {
                  snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
                  projection: BASE_PROJECTION,
                },
              }
            : {
                _tag: "present" as const,
                snapshot: { snapshotSequence: 40, projection: reconnectProjection },
              },
      });
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Reconnect HTTP catch-up",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Reconnect HTTP catch-up",
      );
      expect(live.status).toBe("live");
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(2);
      expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThanOrEqual(1);
    }),
  );

  it.effect("resubscribes for a completion marker when reconnect HTTP is unavailable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: (loaderCall) =>
          loaderCall === 1
            ? {
                _tag: "present" as const,
                snapshot: {
                  snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
                  projection: BASE_PROJECTION,
                },
              }
            : { _tag: "unavailable" as const },
      });
      // First HTTP installs under Syncing. Do not leave a leftover
      // synchronized marker on the socket queue; it can be applied after
      // reconnect and clear catch-up before the unavailable resubscribe starts.
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(2);
      expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThanOrEqual(2);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(live.status).toBe("live");
      expect(Option.getOrThrow(live.data)).toEqual(BASE_PROJECTION);
    }),
  );

  it.effect("restarts subscribe after reconnect while the session is down", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: (loaderCall) =>
          loaderCall === 1
            ? {
                _tag: "present" as const,
                snapshot: {
                  snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
                  projection: BASE_PROJECTION,
                },
              }
            : { _tag: "unavailable" as const },
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      const subscriptionsBefore = yield* Ref.get(harness.subscriptionCount);

      yield* SubscriptionRef.set(harness.supervisorSession, Option.none());
      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) > subscriptionsBefore) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThan(subscriptionsBefore);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(live.status).toBe("live");
    }),
  );

  it.effect("resumes a replacement mobile session from its bounded sequence", () =>
    Effect.gen(function* () {
      const refreshedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Refreshed after reconnect" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 30, projection: refreshedProjection },
        },
      });
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Refreshed after reconnect",
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
        yield* Effect.yieldNow;
      }

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      const refreshed = yield* Ref.get(harness.latest);

      expect(refreshed.status).toBe("live");
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(30);
      expect(Option.getOrThrow(refreshed.data).thread.title).toBe("Refreshed after reconnect");

      yield* Queue.offer(harness.inputs, titleUpdated("Replacement session is live", 31));
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Replacement session is live",
      );

      // A delayed long-background wakeup re-arms catch-up and requests a
      // fresh completion marker. Session replace already subscribed once.
      const loaderCallsBeforeReconnect = yield* Ref.get(harness.loaderCalls);
      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.loaderCalls)) > loaderCallsBeforeReconnect) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThan(loaderCallsBeforeReconnect);
      expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("bounds an oversized resume after a replacement mobile session", () =>
    Effect.gen(function* () {
      const initialBoundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Initial bounded window" },
      };
      const latestBoundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Latest bounded window" },
      };
      const harness = yield* makeHarness({
        cached: BASE_PROJECTION,
        completionMarker: true,
        refreshCachedThreadOnSubscribe: true,
        httpSnapshot: (loaderCall) => ({
          _tag: "present",
          snapshot:
            loaderCall === 1
              ? { snapshotSequence: 30, projection: initialBoundedProjection }
              : { snapshotSequence: 500, projection: latestBoundedProjection },
          history: {
            historyCursor: loaderCall === 1 ? "initial-cursor" : "latest-cursor",
            hasMoreHistory: true,
          },
        }),
      });
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Initial bounded window",
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
        yield* Effect.yieldNow;
      }

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(30);

      // The server replaces an oversized event replay with a full socket
      // snapshot. Mobile substitutes the current bounded HTTP window instead.
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Oversized full snapshot" },
          },
          500,
        ),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      const bounded = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest bounded window",
      );

      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);
      expect(bounded.history).toMatchObject({
        historyCursor: "latest-cursor",
        hasMoreHistory: true,
      });

      const subscriptionsBeforeProbe = yield* Ref.get(harness.subscriptionCount);
      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) > subscriptionsBeforeProbe) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(500);
    }),
  );

  // Client subscribe lifecycle, not a server replay fixture: the hole is the
  // mobile atom keeping awaitingCatchUp after a stale afterSequence subscribe
  // while HTTP is not a live fence and no snapshot/synchronized arrives.
  it.effect(
    "resubscribes from the HTTP cursor when catch-up HTTP arrives after a stale resume",
    () =>
      Effect.gen(function* () {
        const httpDelay = yield* Deferred.make<void>();
        const latestProjection: OrchestrationV2ThreadProjection = {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Latest after delayed HTTP" },
        };
        const harness = yield* makeHarness({
          cached: BASE_PROJECTION,
          completionMarker: true,
          refreshCachedThreadOnSubscribe: true,
          httpDelay,
          httpSnapshot: {
            _tag: "present",
            snapshot: { snapshotSequence: 40, projection: latestProjection },
          },
        });
        yield* awaitThreadState(
          harness.observed,
          (value) => value.status === "synchronizing" && Option.isSome(value.data),
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
        expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

        yield* Deferred.succeed(httpDelay, undefined);
        yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "synchronizing" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Latest after delayed HTTP",
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.lastSubscribeAfterSequence)) === 40) break;
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThanOrEqual(2);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(40);
        expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

        yield* Queue.offer(harness.inputs, synchronized());
        const live = yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Latest after delayed HTTP",
        );
        expect(live.status).toBe("live");
      }),
  );

  it.effect(
    "resubscribes from the HTTP cursor after reconnect when the replacement marker is already consumed",
    () =>
      Effect.gen(function* () {
        const httpDelay = yield* Deferred.make<void>();
        const latestProjection: OrchestrationV2ThreadProjection = {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Latest after overview reconnect" },
        };
        const harness = yield* makeHarness({
          cached: BASE_PROJECTION,
          completionMarker: true,
          refreshCachedThreadOnSubscribe: true,
          httpDelay,
          httpSnapshot: {
            _tag: "present",
            snapshot: { snapshotSequence: 40, projection: latestProjection },
          },
        });
        yield* awaitThreadState(
          harness.observed,
          (value) => value.status === "synchronizing" && Option.isSome(value.data),
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) >= 1) break;
          yield* Effect.yieldNow;
        }
        yield* Queue.offer(harness.inputs, synchronized());
        yield* awaitThreadState(harness.observed, (value) => value.status === "live");
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);

        yield* Queue.offer(harness.wakeups, "application-active-reconnect");
        yield* awaitThreadState(
          harness.observed,
          (value) => value.status === "synchronizing" && Option.isSome(value.data),
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
        expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

        yield* Deferred.succeed(httpDelay, undefined);
        yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "synchronizing" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Latest after overview reconnect",
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(harness.lastSubscribeAfterSequence)) === 40) break;
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.subscriptionCount)).toBeGreaterThanOrEqual(3);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(40);
        expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

        yield* Queue.offer(harness.inputs, synchronized());
        const live = yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Latest after overview reconnect",
        );
        expect(live.status).toBe("live");
      }),
  );
});
