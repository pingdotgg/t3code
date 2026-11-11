import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  decodeStoredThreadSnapshot,
  makeStoredThreadSnapshotEncoder,
} from "../platform/threadCacheEncoding.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import {
  createEnvironmentThreadStateAtoms,
  type EnvironmentThreadState,
  type LeftThreadRetention,
} from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const encodeCompactRecord = makeStoredThreadSnapshotEncoder({
  format: "compact",
  yieldToHost: Effect.void,
});
const encodeStoredThreadSnapshot = (stored: Parameters<typeof encodeCompactRecord>[0]) =>
  encodeCompactRecord(stored).pipe(Effect.map(Option.getOrThrow));

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const THREAD: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};
const SNAPSHOT: OrchestrationV2ThreadDetailSnapshot = { snapshotSequence: 7, projection: THREAD };

const makeHarness = Effect.fn("TestThreadAtoms.makeHarness")(function* (options?: {
  readonly snapshot?: OrchestrationV2ThreadDetailSnapshot;
  readonly socketSnapshot?: false;
  /** Serves each thread its own projection and keeps saved threads, like the real cache. */
  readonly projectionFor?: (threadId: ThreadId) => OrchestrationV2ThreadProjection;
  readonly leftThreads?: LeftThreadRetention;
  /** Saves as the real cache does, so a reopened thread has been through its record format. */
  readonly throughCacheRecord?: boolean;
  /** Runs before each save, to hold one back or fail it. */
  readonly beforeSave?: (
    threadId: ThreadId,
  ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
}) {
  const savedThreads = new Map<ThreadId, OrchestrationV2ThreadDetailSnapshot>();
  // Offered once a thread state's scope has run all its finalizers.
  const threadScopesClosed = yield* Queue.unbounded<void>();
  const subscriptions = yield* Queue.unbounded<{
    readonly threadId: ThreadId;
    readonly afterSequence: number | undefined;
    readonly events: Queue.Queue<OrchestrationV2ThreadStreamItem>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  const olderLoads = yield* Queue.unbounded<{
    readonly cursor: string | null;
    readonly response: Deferred.Deferred<OrchestrationV2ThreadHistoryPage>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  const snapshot = options?.snapshot ?? SNAPSHOT;
  let httpLoads = 0;
  let diskLoads = 0;
  let opened = 0;
  let active = 0;
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
      readonly threadId: ThreadId;
      readonly afterSequence?: number;
    }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              opened += 1;
              active += 1;
            }),
            () =>
              Effect.sync(() => {
                active -= 1;
              }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
          );
          yield* Queue.offer(subscriptions, {
            threadId: input.threadId,
            afterSequence: input.afterSequence,
            events,
            closed,
          });
          // Like a paging server, a fresh subscribe opens with the bounded snapshot.
          if (input.afterSequence === undefined && options?.socketSnapshot !== false) {
            yield* Queue.offer(events, {
              kind: "snapshot",
              ...snapshot,
              ...(options?.projectionFor
                ? { projection: options.projectionFor(input.threadId) }
                : {}),
            });
          }
          return Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: true,
      threadSnapshotPagination: true,
    } as never),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  // Each change replaces the environment's entry, like learning a route, which restarts its streams.
  const environmentEntry = yield* SubscriptionRef.make(0);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected environment registration"),
    assertKnownAddress: () => Effect.die("Unexpected address check"),
    reconcilePlatform: () => Effect.die("Unexpected environment reconciliation"),
    remove: () => Effect.die("Unexpected environment removal"),
    removeRoute: () => Effect.die("Unexpected route removal"),
    reorderRoutes: () => Effect.die("Unexpected route reorder"),
    removeRelayEnvironments: () => Effect.die("Unexpected environment removal"),
    retryNow: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected environment toggle"),
    setCompatibility: () => Effect.die("Unexpected compatibility update"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) => {
      const follow = Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      ).pipe(Stream.ensuring(Queue.offer(threadScopesClosed, undefined)));
      return options?.leftThreads === undefined
        ? follow
        : Stream.concat(
            Stream.fromEffect(SubscriptionRef.get(environmentEntry)),
            SubscriptionRef.changes(environmentEntry),
          ).pipe(
            Stream.changes,
            Stream.switchMap(() => follow),
          );
    },
  });
  const historyController = yield* Effect.service(
    ThreadHistoryController.ThreadHistoryController,
  ).pipe(Effect.provide(ThreadHistoryController.layer));
  const historyHttpClient = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const response = yield* Deferred.make<OrchestrationV2ThreadHistoryPage>();
      const closed = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
      yield* Queue.offer(olderLoads, { cursor: url.searchParams.get("cursor"), response, closed });
      const page = yield* Deferred.await(response);
      return HttpClientResponse.fromWeb(request, Response.json(page));
    }).pipe(Effect.scoped),
  );
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(ThreadHistoryController.ThreadHistoryController, historyController),
      Layer.succeed(HttpClient.HttpClient, historyHttpClient),
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        Persistence.EnvironmentCacheStore,
        Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: (_environmentId, threadId) =>
            Effect.sync(() => {
              diskLoads += 1;
              return Option.fromUndefinedOr(savedThreads.get(threadId));
            }),
          saveThread: (_environmentId, saved) =>
            (options?.beforeSave?.(saved.projection.thread.id) ?? Effect.void).pipe(
              Effect.andThen(
                options?.throughCacheRecord === true
                  ? encodeStoredThreadSnapshot({
                      environmentId: TARGET.environmentId,
                      threadId: saved.projection.thread.id,
                      snapshot: saved,
                    }).pipe(Effect.flatMap(decodeStoredThreadSnapshot), Effect.orDie)
                  : Effect.succeed({ snapshot: saved }),
              ),
              Effect.tap(({ snapshot: stored }) =>
                Effect.sync(() => {
                  if (options?.projectionFor) savedThreads.set(stored.projection.thread.id, stored);
                }),
              ),
              Effect.asVoid,
            ),
          removeThread: (_environmentId, threadId) =>
            Effect.sync(() => {
              savedThreads.delete(threadId);
            }),
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ThreadSnapshotLoader.ThreadSnapshotLoader,
        ThreadSnapshotLoader.ThreadSnapshotLoader.of({
          load: (_prepared, threadId) =>
            Effect.sync(() => {
              httpLoads += 1;
              return {
                _tag: "present" as const,
                snapshot: options?.projectionFor
                  ? { ...snapshot, projection: options.projectionFor(threadId) }
                  : snapshot,
                ...(snapshot.historyCursor === undefined
                  ? {}
                  : {
                      history: {
                        historyCursor: snapshot.historyCursor,
                        hasMoreHistory: snapshot.hasMoreHistory ?? false,
                        latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
                      },
                    }),
              };
            }),
        }),
      ),
    ),
  );
  const raw = createEnvironmentThreadStateAtoms(
    runtime,
    options?.leftThreads && { leftThreads: options.leftThreads },
  );
  const details = createEnvironmentThreadDetailAtoms(raw.stateAtom);
  const ref = { environmentId: TARGET.environmentId, threadId: THREAD_ID };
  const stateAtom = details.stateAtom(ref);
  const makeRegistry = Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const registry = yield* makeRegistry;

  return {
    registry,
    makeRegistry,
    rawAtoms: raw,
    stateAtom,
    details,
    ref,
    subscriptions,
    olderLoads,
    threadScopesClosed,
    restartEnvironment: SubscriptionRef.update(environmentEntry, (entry) => entry + 1),
    loadEarlier: () => historyController.loadEarlier(TARGET.environmentId, THREAD_ID),
    counts: () => ({ httpLoads, diskLoads, opened, active }),
  };
});

function observeState(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

function currentThread(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<EnvironmentThreadState>,
) {
  return Option.getOrThrow(registry.get(atom).data);
}

describe("createEnvironmentThreadStateAtoms", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.effect("keeps warm data and resumes a completed cursor without loading another snapshot", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(first.events, {
        kind: "event",
        sequence: 8,
        event: {
          id: EventId.make("metadata-1"),
          type: "thread.metadata-updated",
          threadId: THREAD_ID,
          occurredAt: THREAD.thread.updatedAt,
          payload: { ...THREAD.thread, title: "Retained title" },
        },
      });
      yield* Queue.offer(first.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      const before = currentThread(h.registry, h.stateAtom);
      unmount();
      yield* Deferred.await(first.closed);
      const remount = h.registry.mount(h.stateAtom);
      expect(currentThread(h.registry, h.stateAtom)).toBe(before);
      const next = yield* Queue.take(h.subscriptions);
      expect(next.afterSequence).toBe(8);
      expect(h.counts()).toEqual({ httpLoads: 0, diskLoads: 1, opened: 2, active: 1 });
      remount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect("cancels older-page work on unmount and permits it again on a warm return", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        snapshot: {
          ...SNAPSHOT,
          historyCursor: "older-1",
          hasMoreHistory: true,
        },
      });
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      const loading = yield* h.loadEarlier().pipe(Effect.forkScoped);
      const older = yield* Queue.take(h.olderLoads);
      expect(h.registry.get(h.stateAtom).history.loading).toBe(true);
      unmount();
      yield* Deferred.await(first.closed);
      yield* Deferred.await(older.closed);
      yield* Fiber.await(loading);
      const remount = h.registry.mount(h.stateAtom);
      const next = yield* Queue.take(h.subscriptions);
      expect(h.registry.get(h.stateAtom).history.loading).toBe(false);
      const retrying = yield* h.loadEarlier().pipe(Effect.forkScoped);
      const retried = yield* Queue.take(h.olderLoads);
      expect(retried.cursor).toBe("older-1");
      expect(h.counts().httpLoads).toBe(0);
      remount();
      yield* Deferred.await(next.closed);
      yield* Deferred.await(retried.closed);
      yield* Fiber.await(retrying);
    }),
  );

  it.effect("opens from the bounded socket snapshot without HTTP and merges older history", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ socketSnapshot: false });
      const unmount = h.registry.mount(h.stateAtom);
      const subscription = yield* Queue.take(h.subscriptions);
      expect(subscription.afterSequence).toBeUndefined();

      yield* Queue.offer(subscription.events, {
        kind: "snapshot",
        snapshotSequence: 12,
        projection: THREAD,
        historyCursor: "socket-older-1",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 4,
      });
      yield* Queue.offer(subscription.events, { kind: "synchronized" });
      yield* observeState(
        h.registry,
        h.stateAtom,
        (state) => state.status === "live" && state.history.historyCursor === "socket-older-1",
      );

      const loading = yield* h.loadEarlier().pipe(Effect.forkScoped);
      const request = yield* Queue.take(h.olderLoads);
      expect(request.cursor).toBe("socket-older-1");
      const olderItem = {
        id: TurnItemId.make("socket-fallback-older-item"),
        type: "command_execution" as const,
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed" as const,
        title: "Earlier command",
        input: "pwd",
        output: "/workspace",
        exitCode: 0,
        startedAt: THREAD.thread.createdAt,
        completedAt: THREAD.thread.createdAt,
        updatedAt: THREAD.thread.createdAt,
      };
      yield* Deferred.succeed(request.response, {
        snapshotSequence: 12,
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
      });
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });

      const state = h.registry.get(h.stateAtom);
      expect(Option.getOrThrow(state.data).visibleTurnItems.map((row) => row.sourceItemId)).toEqual(
        [olderItem.id],
      );
      expect(state.history).toMatchObject({
        historyCursor: null,
        hasMoreHistory: false,
        loading: false,
        error: null,
        expanded: true,
        latestLocalTurnOrdinal: 4,
      });
      expect(h.counts().httpLoads).toBe(0);

      unmount();
      yield* Deferred.await(subscription.closed);
    }),
  );
});

it.effect("keeps snapshot boundaries and completion markers ordered inside a replay batch", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const unmount = h.registry.mount(h.stateAtom);
    const first = yield* Queue.take(h.subscriptions);
    const title = (sequence: number, value: string): OrchestrationV2ThreadStreamItem => ({
      kind: "event",
      sequence,
      event: {
        id: EventId.make(`batch-title-${sequence}`),
        type: "thread.metadata-updated",
        threadId: THREAD_ID,
        occurredAt: THREAD.thread.updatedAt,
        payload: { ...THREAD.thread, title: value },
      },
    });
    yield* Queue.offerAll(first.events, [
      title(8, "Before snapshot"),
      {
        kind: "snapshot",
        snapshotSequence: 20,
        projection: THREAD,
        historyCursor: "older-batch",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 10,
      },
      title(21, "After snapshot"),
      title(19, "Stale replay"),
      { kind: "synchronized" },
    ]);
    const state = yield* observeState(h.registry, h.stateAtom, (value) => value.status === "live");
    expect(Option.getOrThrow(state.data).thread.title).toBe("After snapshot");
    expect(state.history.historyCursor).toBe("older-batch");
    expect(state.history.latestLocalTurnOrdinal).toBe(10);
    unmount();
    yield* Deferred.await(first.closed);
    const remount = h.registry.mount(h.stateAtom);
    const next = yield* Queue.take(h.subscriptions);
    expect(next.afterSequence).toBe(21);
    remount();
    yield* Deferred.await(next.closed);
  }),
);

describe("left threads", () => {
  type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
  const LEFT = Array.from({ length: 6 }, (_, index) => ThreadId.make(`left-${index}`));
  const BODY = 10_000;
  // Three left threads of BODY fit, besides the one just left; four do not.
  const MAX_BYTES = 35_000;
  const at = THREAD.thread.createdAt;
  const RUNNING: OrchestrationV2Run = {
    id: RunId.make("left-run"),
    threadId: LEFT[0]!,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make("left-message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "running",
    requestedAt: at,
    startedAt: at,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const itemIdOf = (threadId: ThreadId) => TurnItemId.make(`${threadId}-notice`);
  const itemsFor = (threadId: ThreadId, bytes: number) => {
    const item = {
      id: itemIdOf(threadId),
      type: "system_notice" as const,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: null,
      message: "x".repeat(bytes),
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    return {
      turnItems: [item],
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local" as const,
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        },
      ],
    };
  };
  const projectionFor =
    (options?: {
      readonly running?: ReadonlySet<ThreadId>;
      readonly bytes?: (threadId: ThreadId) => number;
    }) =>
    (threadId: ThreadId): OrchestrationV2ThreadProjection => ({
      ...THREAD,
      ...itemsFor(threadId, options?.bytes?.(threadId) ?? BODY),
      thread: { ...THREAD.thread, id: threadId },
      runs: options?.running?.has(threadId) ? [{ ...RUNNING, threadId }] : [],
    });
  const event = (threadId: ThreadId, deleted: boolean): OrchestrationV2ThreadStreamItem => {
    const payload = { ...THREAD.thread, id: threadId, title: `Visited ${threadId}` };
    const common = { id: EventId.make(`left-${threadId}`), threadId, occurredAt: at };
    return {
      kind: "event",
      sequence: 8,
      event: deleted
        ? { ...common, type: "thread.deleted", payload: { ...payload, deletedAt: at } }
        : { ...common, type: "thread.metadata-updated", payload },
    };
  };
  const refOf = (threadId: ThreadId) => ({ environmentId: TARGET.environmentId, threadId });
  const atomOf = (h: Harness, threadId: ThreadId) => h.details.stateAtom(refOf(threadId));
  const budget = (released: ThreadId[], maxBytes = MAX_BYTES): LeftThreadRetention => ({
    maxBytes,
    onRelease: (thread) => released.push(thread.threadId),
  });

  /** Opens the thread, retitles it at sequence 8 (or deletes it), and returns how to leave it. */
  const open = Effect.fn("TestThreadAtoms.open")(function* (
    h: Harness,
    threadId: ThreadId,
    options?: { readonly deleted?: boolean; readonly secondary?: boolean },
  ) {
    const deleted = options?.deleted === true;
    const atom = atomOf(h, threadId);
    if (options?.secondary !== true) h.rawAtoms.markThreadVisited(refOf(threadId));
    const unmount = h.registry.mount(atom);
    const subscription = yield* Queue.take(h.subscriptions);
    expect(subscription.threadId).toBe(threadId);
    yield* Queue.offerAll(subscription.events, [
      event(threadId, deleted),
      { kind: "synchronized" },
    ]);
    yield* observeState(h.registry, atom, (state) =>
      deleted
        ? state.status === "deleted"
        : state.status === "live" &&
          Option.getOrNull(state.data)?.thread.title !== THREAD.thread.title,
    );
    return { unmount, subscription };
  });

  const visit = Effect.fn("TestThreadAtoms.visit")(function* (
    h: Harness,
    threadId: ThreadId,
    options?: { readonly deleted?: boolean; readonly secondary?: boolean },
  ) {
    const { unmount } = yield* open(h, threadId, options);
    unmount();
    yield* Queue.take(h.threadScopesClosed);
  });

  /** Reopens a left thread and reports whether it came from memory. */
  const reopen = Effect.fn("TestThreadAtoms.reopen")(function* (h: Harness, threadId: ThreadId) {
    const diskLoads = h.counts().diskLoads;
    const atom = atomOf(h, threadId);
    h.rawAtoms.markThreadVisited(refOf(threadId));
    const unmount = h.registry.mount(atom);
    const subscription = yield* Queue.take(h.subscriptions);
    const warm = h.counts().diskLoads === diskLoads;
    const state = yield* observeState(h.registry, atom, (value) => Option.isSome(value.data));
    unmount();
    yield* Queue.take(h.threadScopesClosed);
    return { warm, state, afterSequence: subscription.afterSequence };
  });

  it.effect("keeps left threads within the budget warm and reopens others from the cache", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: budget(released),
      });
      for (const threadId of LEFT.slice(0, 5)) yield* visit(h, threadId);
      expect(released).toEqual([LEFT[0]]);
      // Reopening refreshes a thread's place, so the next visit drops left-2 rather than left-1.
      expect((yield* reopen(h, LEFT[1]!)).warm).toBe(true);
      yield* visit(h, LEFT[5]!);
      expect(released).toEqual([LEFT[0], LEFT[2]]);
      const httpLoads = h.counts().httpLoads;
      const reopened = yield* reopen(h, LEFT[0]!);
      expect(reopened.warm).toBe(false);
      const projection = Option.getOrThrow(reopened.state.data);
      expect(projection.thread.title).toBe(`Visited ${LEFT[0]}`);
      expect(projection.turnItems.map((item) => item.id)).toEqual([itemIdOf(LEFT[0]!)]);
      expect(projection.visibleTurnItems.map((row) => row.sourceItemId)).toEqual([
        itemIdOf(LEFT[0]!),
      ]);
      expect(reopened.afterSequence).toBe(8);
      expect(h.counts().httpLoads).toBe(httpLoads);
    }),
  );

  it.effect("drops a heavy left thread and keeps the small ones warm", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const heavy = LEFT[4]!;
      const h = yield* makeHarness({
        projectionFor: projectionFor({
          bytes: (threadId) => (threadId === heavy ? 40_000 : 1_000),
        }),
        leftThreads: budget(released),
      });
      for (const threadId of LEFT.slice(0, 5)) yield* visit(h, threadId);
      // Just left, so it does not count: nothing is dropped to make room for it.
      expect(released).toEqual([]);
      yield* visit(h, LEFT[5]!);
      expect(released).toEqual([heavy]);
      for (const threadId of LEFT.slice(0, 4)) {
        expect((yield* reopen(h, threadId)).warm).toBe(true);
      }
    }),
  );

  it.effect("stays warm going back and forth between two threads over the budget", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: budget(released, 0),
      });
      yield* visit(h, LEFT[0]!);
      yield* visit(h, LEFT[1]!);
      expect(released).toEqual([LEFT[0]]);
      yield* visit(h, LEFT[0]!);
      expect((yield* reopen(h, LEFT[0]!)).warm).toBe(true);
      expect((yield* reopen(h, LEFT[0]!)).warm).toBe(true);
    }),
  );

  it.effect("does not let threads the user never navigated to crowd out left threads", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: budget(released, 0),
      });
      yield* visit(h, LEFT[0]!);
      // A side chat, a fork source, a cited thread: all mount the same state atom.
      for (const threadId of LEFT.slice(1)) yield* visit(h, threadId, { secondary: true });
      expect(released).toEqual([]);
      expect((yield* reopen(h, LEFT[0]!)).warm).toBe(true);
      expect((yield* reopen(h, LEFT[1]!)).warm).toBe(true);
    }),
  );

  it.effect("keeps threads with unfinished runs outside the budget", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const running = new Set(LEFT.slice(0, 3));
      const h = yield* makeHarness({
        projectionFor: projectionFor({ running }),
        leftThreads: budget(released, 15_000),
      });
      for (const threadId of LEFT.slice(0, 4)) yield* visit(h, threadId);
      // One settled thread fits, besides the one just left, whatever the running ones hold.
      yield* visit(h, LEFT[4]!);
      expect(released).toEqual([]);
      yield* visit(h, LEFT[5]!);
      expect(released).toEqual([LEFT[3]]);
      const first = yield* reopen(h, LEFT[0]!);
      expect(first.warm).toBe(true);
      expect(Option.getOrThrow(first.state.data).runs[0]?.status).toBe("running");
    }),
  );

  describe("with a pending question", () => {
    const QUESTION = {
      id: RuntimeRequestId.make("left-question"),
      nodeId: NodeId.make("left-question-node"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: at,
      resolvedAt: null,
    };
    // As the server sends one that a run has pushed out of the window: after the window's items.
    const withQuestion = (threadId: ThreadId): OrchestrationV2ThreadProjection => {
      const projection = projectionFor()(threadId);
      const { message: _message, ...notice } = itemsFor(threadId, 0).turnItems[0]!;
      return {
        ...projection,
        runtimeRequests: [QUESTION],
        turnItems: [
          ...projection.turnItems,
          {
            ...notice,
            id: TurnItemId.make(`${threadId}-question`),
            nodeId: QUESTION.nodeId,
            ordinal: 0,
            status: "running",
            completedAt: null,
            type: "user_input_request",
            requestId: QUESTION.id,
            questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [] }],
          },
        ],
      };
    };
    const questionsOf = (state: {
      readonly data: Option.Option<OrchestrationV2ThreadProjection>;
    }) =>
      derivePendingThreadRequests(Option.getOrThrow(state.data)).userInputs.map(
        (input) => input.requestId,
      );

    it.effect("stays outside the budget, even with no unfinished run", () =>
      Effect.gen(function* () {
        const released: ThreadId[] = [];
        const asking = LEFT[0]!;
        const h = yield* makeHarness({
          projectionFor: (threadId) =>
            threadId === asking ? withQuestion(threadId) : projectionFor()(threadId),
          leftThreads: budget(released, 0),
        });
        for (const threadId of LEFT.slice(0, 3)) yield* visit(h, threadId);
        expect(released).toEqual([LEFT[1]]);
        const reopened = yield* reopen(h, asking);
        expect(reopened.warm).toBe(true);
        expect(questionsOf(reopened.state)).toEqual([QUESTION.id]);
      }),
    );

    it.effect("is still answerable when the idle TTL released its thread", () =>
      Effect.gen(function* () {
        const released: ThreadId[] = [];
        const h = yield* makeHarness({
          projectionFor: withQuestion,
          throughCacheRecord: true,
          leftThreads: budget(released),
        });
        const { unmount } = yield* open(h, LEFT[0]!);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        unmount();
        yield* Queue.take(h.threadScopesClosed);
        for (let round = 0; round < 3; round++) {
          vi.advanceTimersByTime(THREAD_SNAPSHOT_IDLE_TTL_MS + 1_000);
          yield* Effect.yieldNow;
        }
        expect(released).toEqual([LEFT[0]]);
        vi.useRealTimers();
        const httpLoads = h.counts().httpLoads;
        const reopened = yield* reopen(h, LEFT[0]!);
        expect(reopened.warm).toBe(false);
        expect(reopened.afterSequence).toBe(8);
        expect(h.counts().httpLoads).toBe(httpLoads);
        expect(questionsOf(reopened.state)).toEqual([QUESTION.id]);
      }),
    );
  });

  it.effect("keeps a deleted thread deleted after it is left", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: budget(released, 0),
      });
      yield* visit(h, LEFT[0]!, { deleted: true });
      for (const threadId of LEFT.slice(1)) yield* visit(h, threadId);
      expect(released).not.toContain(LEFT[0]);
      const diskLoads = h.counts().diskLoads;
      const atom = atomOf(h, LEFT[0]!);
      const unmount = h.registry.mount(atom);
      yield* observeState(h.registry, atom, (state) => state.status === "deleted");
      expect(h.counts().diskLoads).toBe(diskLoads);
      expect(yield* Queue.size(h.subscriptions)).toBe(0);
      unmount();
      yield* Queue.take(h.threadScopesClosed);
    }),
  );

  it.effect("leaves an open thread and the left threads alone when its environment restarts", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: budget(released, 0),
      });
      yield* visit(h, LEFT[0]!);
      const { unmount } = yield* open(h, LEFT[1]!);
      const before = currentThread(h.registry, atomOf(h, LEFT[1]!));
      const diskLoads = h.counts().diskLoads;
      yield* h.restartEnvironment;
      yield* Queue.take(h.threadScopesClosed);
      const resumed = yield* Queue.take(h.subscriptions);
      expect(resumed.threadId).toBe(LEFT[1]);
      expect(resumed.afterSequence).toBe(8);
      expect(h.counts().diskLoads).toBe(diskLoads);
      expect(currentThread(h.registry, atomOf(h, LEFT[1]!))).toBe(before);
      expect(released).toEqual([]);
      unmount();
      yield* Queue.take(h.threadScopesClosed);
      // Leaving it for real is what pushes the older thread out.
      expect(released).toEqual([LEFT[0]]);
    }),
  );

  it.effect("reopens a released expanded thread from its saved window", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        snapshot: { ...SNAPSHOT, historyCursor: "older-1", hasMoreHistory: true },
        projectionFor: projectionFor(),
        leftThreads: budget(released, 0),
      });
      h.rawAtoms.markThreadVisited(h.ref);
      const unmount = h.registry.mount(h.stateAtom);
      const subscription = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(subscription.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      const loading = yield* h.loadEarlier().pipe(Effect.forkScoped);
      const request = yield* Queue.take(h.olderLoads);
      const older = itemsFor(THREAD_ID, 10).visibleTurnItems[0]!;
      const olderItem = { ...older.item, id: TurnItemId.make("older-item") };
      yield* Deferred.succeed(request.response, {
        snapshotSequence: 7,
        items: [{ ...older, sourceItemId: olderItem.id, item: olderItem }],
        nextCursor: null,
        hasMoreHistory: false,
      });
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.history.expanded);
      unmount();
      yield* Queue.take(h.threadScopesClosed);

      yield* visit(h, LEFT[0]!);
      expect(released).toEqual([THREAD_ID]);
      const httpLoads = h.counts().httpLoads;
      const reopened = yield* reopen(h, THREAD_ID);
      expect(reopened.warm).toBe(false);
      expect(reopened.state.history).toMatchObject({
        expanded: false,
        historyCursor: "older-1",
        hasMoreHistory: true,
      });
      expect(
        Option.getOrThrow(reopened.state.data).visibleTurnItems.map((row) => row.sourceItemId),
      ).toEqual([itemIdOf(THREAD_ID)]);
      expect(h.counts().httpLoads).toBe(httpLoads);
    }),
  );

  it.effect("keeps a thread in memory when its final save failed", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: budget(released, 0),
        beforeSave: (threadId) =>
          threadId === LEFT[0]
            ? Effect.fail(
                new Persistence.ConnectionPersistenceError({
                  operation: "save-thread",
                  message: "quota",
                }),
              )
            : Effect.void,
      });
      for (const threadId of LEFT.slice(0, 3)) yield* visit(h, threadId);
      expect(released).toEqual([LEFT[1]]);
      const kept = yield* reopen(h, LEFT[0]!);
      expect(kept.warm).toBe(true);
      expect(Option.getOrThrow(kept.state.data).thread.title).toBe(`Visited ${LEFT[0]}`);
    }),
  );

  it.effect("releases a left thread only after its final save finished", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const releases = yield* Queue.unbounded<void>();
      const saving = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: {
          maxBytes: 0,
          onRelease: (thread) => {
            released.push(thread.threadId);
            Queue.offerUnsafe(releases, undefined);
          },
        },
        beforeSave: (threadId) =>
          threadId === LEFT[0]
            ? Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(gate)))
            : Effect.void,
      });
      const { unmount } = yield* open(h, LEFT[0]!);
      unmount();
      yield* Deferred.await(saving);
      // The stream's ensuring runs ahead of the scope's finalizers, so this one is already there.
      yield* Queue.take(h.threadScopesClosed);
      for (const threadId of LEFT.slice(1, 3)) yield* visit(h, threadId);
      // left-0 is still saving, so it is not in the budget yet.
      expect(released).toEqual([LEFT[1]]);
      yield* Deferred.succeed(gate, undefined);
      // left-1's release is already queued; the finished save causes the next one.
      yield* Queue.take(releases);
      yield* Queue.take(releases);
      expect(released).toEqual([LEFT[1], LEFT[2]]);
      yield* visit(h, LEFT[3]!);
      expect(released).toEqual([LEFT[1], LEFT[2], LEFT[0]]);
      const reopened = yield* reopen(h, LEFT[0]!);
      expect(reopened.warm).toBe(false);
      expect(Option.getOrThrow(reopened.state.data).thread.title).toBe(`Visited ${LEFT[0]}`);
    }),
  );

  it.effect("reports a thread released by the idle TTL, visited or not", () =>
    Effect.gen(function* () {
      const released: ThreadId[] = [];
      const h = yield* makeHarness({
        projectionFor: projectionFor(),
        leftThreads: budget(released),
      });
      const { unmount } = yield* open(h, LEFT[0]!, { secondary: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      unmount();
      yield* Queue.take(h.threadScopesClosed);
      expect(released).toEqual([]);
      // The derived atoms go first, on the registry's default TTL, and let go of the resume atom.
      for (let round = 0; round < 3; round++) {
        vi.advanceTimersByTime(THREAD_SNAPSHOT_IDLE_TTL_MS + 1_000);
        yield* Effect.yieldNow;
      }
      expect(released).toEqual([LEFT[0]]);
    }),
  );

  it.effect("keeps every left thread until the TTL without a budget", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ projectionFor: projectionFor() });
      for (const threadId of LEFT) yield* visit(h, threadId);
      for (const threadId of LEFT) expect((yield* reopen(h, threadId)).warm).toBe(true);
    }),
  );
});
