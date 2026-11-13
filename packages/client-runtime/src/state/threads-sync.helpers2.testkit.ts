// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  RuntimeRequestId,
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
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
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
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
} from "../platform/orchestrationCache.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { onThreadRequestsResolved, type ThreadRequestsResolved } from "./threadRequests.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

export const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

export const THREAD_ID = v2ThreadId;

export const CACHED_SNAPSHOT_SEQUENCE = 7;

export const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

export const BASE_PROJECTION: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};

export type TestThreadInput = OrchestrationV2ThreadStreamItem | Error;

export function testSession(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({} as never),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

export function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

export const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationV2ThreadProjection;
  readonly cachedHistory?: {
    readonly historyCursor: string | null;
    readonly hasMoreHistory: boolean;
    readonly latestLocalTurnOrdinal?: number | null;
  };
  readonly httpSnapshot?: ThreadSnapshotLoadResult;
  /** The test sends the completion marker itself instead of the fake server sending it first. */
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
  const subscriptionCount = yield* SubscriptionRef.make(0);
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
        Ref.set(lastSubscribeAfterSequence, input.afterSequence).pipe(
          Effect.andThen(
            Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker === true),
          ),
          Effect.andThen(Ref.set(lastAcceptBoundedSnapshot, input.acceptBoundedSnapshot)),
          Effect.andThen(Ref.set(lastAcceptCompactTurnItems, input.acceptCompactTurnItems)),
          Effect.andThen(SubscriptionRef.update(subscriptionCount, (count) => count + 1)),
          Effect.as(
            options?.completionMarker === true
              ? streamFrom(inputs)
              : Stream.concat(Stream.make(synchronized()), streamFrom(inputs)),
          ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input: { readonly itemId: TurnItemId }) =>
      options?.getTurnItem?.(input) ?? Effect.die("Unexpected getTurnItem request"),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client)),
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
    loadWork: (anchorId: string) =>
      historyController.loadEarlier(TARGET.environmentId, THREAD_ID, undefined, anchorId),
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
    replaceSession: SubscriptionRef.set(supervisorSession, Option.some(testSession(client))),
  };
});

export const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "snapshot" }> => ({
  kind: "snapshot",
  snapshotSequence,
  projection,
});

export const synchronized = (): OrchestrationV2ThreadStreamItem => ({ kind: "synchronized" });

export const PENDING_QUESTION = {
  id: RuntimeRequestId.make("question"),
  nodeId: NodeId.make("question-node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input" as const,
  status: "pending" as const,
  responseCapability: { type: "message" as const },
  createdAt: v2Now,
  resolvedAt: null,
};

export const questionResolved = (sequence: number): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make("event-request"),
    type: "runtime-request.updated",
    threadId: THREAD_ID,
    occurredAt: v2Now,
    payload: { ...PENDING_QUESTION, status: "resolved", resolvedAt: v2Now },
  },
});

export const titleUpdated = (title: string, sequence = 2): OrchestrationV2ThreadStreamItem => {
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

export const deleted = (sequence = 3): OrchestrationV2ThreadStreamItem => {
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
