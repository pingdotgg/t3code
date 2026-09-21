import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
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
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";
import {
  cachedThreadGeneration,
  evictCachedThread,
  isCachedThreadEvicted,
  persistCachedThread,
  reviveCachedThread,
} from "./threadCache.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
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
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const ACTIVE_THREAD: OrchestrationThread = {
  ...BASE_THREAD,
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-04-01T00:01:00.000Z",
    startedAt: "2026-04-01T00:01:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  session: {
    threadId: THREAD_ID,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-04-01T00:01:00.000Z",
  },
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  options?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      options?.completionMarker === true
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
  readonly cached?: OrchestrationThread;
  readonly cache?: Persistence.EnvironmentCacheStore["Service"];
  readonly removeThread?: Persistence.EnvironmentCacheStore["Service"]["removeThread"];
  readonly httpSnapshot?: Option.Option<OrchestrationThreadDetailSnapshot>;
  readonly completionMarker?: boolean;
  readonly resumeCache?: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]>;
  readonly loadCached?: Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  readonly saveThread?: Persistence.EnvironmentCacheStore["Service"]["saveThread"];
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const stateChangeCount = yield* Ref.make(0);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make<boolean | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  // Preserve queued event batches while failing at the first error.
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.chunks,
      Stream.flatMap((chunk) => {
        const errorIndex = chunk.findIndex((input) => input instanceof Error);
        if (errorIndex === -1) {
          return Stream.fromArray(chunk as ReadonlyArray<OrchestrationThreadStreamItem>);
        }
        const prefix = chunk.slice(0, errorIndex) as ReadonlyArray<OrchestrationThreadStreamItem>;
        const failure = Stream.fail(chunk[errorIndex] as Error);
        return prefix.length === 0 ? failure : Stream.concat(Stream.fromArray(prefix), failure);
      }),
    );
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: boolean;
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker)),
          Effect.as(streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(
      testSession(
        client,
        options?.completionMarker === true ? { completionMarker: true } : undefined,
      ),
    ),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.as(
          threadId === THREAD_ID
            ? (options?.httpSnapshot ?? Option.none<OrchestrationThreadDetailSnapshot>())
            : Option.none<OrchestrationThreadDetailSnapshot>(),
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
  const cache =
    options?.cache ??
    Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeed(Option.none()),
      saveShell: () => Effect.void,
      loadThread: (_environmentId, threadId) =>
        options?.loadCached ??
        Effect.succeed(
          threadId === THREAD_ID && options?.cached !== undefined
            ? Option.some({
                snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
                thread: options.cached,
              })
            : Option.none(),
        ),
      saveThread: (environmentId, thread) =>
        Ref.update(savedThreads, (current) => [...current, thread]).pipe(
          Effect.andThen(options?.saveThread?.(environmentId, thread) ?? Effect.void),
        ),
      removeThread: (_environmentId, threadId) =>
        Ref.update(removedThreads, (current) => [...current, threadId]).pipe(
          Effect.andThen(options?.removeThread?.(_environmentId, threadId) ?? Effect.void),
        ),
      loadServerConfig: () => Effect.succeed(Option.none()),
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeed(Option.none()),
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID, options?.resumeCache).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.update(stateChangeCount, (count) => count + 1).pipe(
        Effect.andThen(Ref.set(latest, state)),
        Effect.andThen(Queue.offer(observed, state)),
      ),
    ),
    Effect.forkScoped,
  );

  return {
    threadState,
    inputs,
    observed,
    latest,
    stateChangeCount,
    retryCount,
    subscriptionCount,
    loaderCalls,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    cache,
    wakeups,
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(
        testSession(
          client,
          options?.completionMarker === true ? { completionMarker: true } : undefined,
        ),
      ),
    ),
  };
});

const snapshot = (thread: OrchestrationThread): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 1,
    thread,
  },
});

const synchronized = (): OrchestrationThreadStreamItem => ({ kind: "synchronized" });

const titleUpdated = (title: string, sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-title"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
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
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const sessionSet = (
  status: "ready" | "running",
  turnId: string,
  sequence: number,
): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-session-${status}-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T03:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.session-set",
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status,
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: status === "running" ? TurnId.make(turnId) : null,
        lastError: null,
        updatedAt: "2026-04-01T03:00:00.000Z",
      },
    },
  },
});

const deleted = (): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence: 3,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.deleted",
    payload: {
      threadId: THREAD_ID,
      deletedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

const archived = (sequence = 3): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-archived"),
    sequence,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.archived",
    payload: {
      threadId: THREAD_ID,
      archivedAt: "2026-04-01T02:00:00.000Z",
      updatedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

const unarchived = (sequence = 4): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-unarchived"),
    sequence,
    occurredAt: "2026-04-01T03:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.unarchived",
    payload: {
      threadId: THREAD_ID,
      updatedAt: "2026-04-01T03:00:00.000Z",
    },
  },
});

describe("EnvironmentThreads", () => {
  for (const source of ["disk", "HTTP"] as const) {
    it.effect(`does not rewrite an unchanged ${source} snapshot on navigation or warm return`, () =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const firstSaved = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeHarness({
              resumeCache,
              ...(source === "disk"
                ? { cached: BASE_THREAD }
                : { httpSnapshot: Option.some({ snapshotSequence: 7, thread: BASE_THREAD }) }),
            });
            yield* awaitThreadState(h.observed, (value) => value.status === "live");
            if (source === "HTTP") yield* TestClock.adjust("500 millis");
            return h.savedThreads;
          }),
        );
        expect(yield* Ref.get(firstSaved)).toHaveLength(source === "disk" ? 0 : 1);
        const nextSaved = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeHarness({ resumeCache });
            yield* awaitThreadState(h.observed, (value) => value.status === "live");
            return h.savedThreads;
          }),
        );
        expect(yield* Ref.get(nextSaved)).toEqual([]);
      }),
    );
  }

  it.effect("retries a failed background cache write when the scope closes", () =>
    Effect.gen(function* () {
      let attempts = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            httpSnapshot: Option.some({ snapshotSequence: 7, thread: BASE_THREAD }),
            saveThread: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts === 1
                  ? Effect.fail(
                      new Persistence.ConnectionPersistenceError({
                        operation: "save-thread",
                        message: "Test storage failure",
                      }),
                    )
                  : Effect.void;
              }),
          });
          yield* awaitThreadState(h.observed, (value) => value.status === "live");
          yield* TestClock.adjust("500 millis");
          expect(attempts).toBe(1);
        }),
      );
      expect(attempts).toBe(2);
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
            cached: BASE_THREAD,
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
            (value) => Option.getOrNull(value.data)?.title === "First update",
          );
          yield* TestClock.adjust("500 millis");
          yield* Deferred.await(writing);
          yield* Queue.offer(h.inputs, titleUpdated("Newer update", 9));
          yield* awaitThreadState(
            h.observed,
            (value) => Option.getOrNull(value.data)?.title === "Newer update",
          );
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(written);
          return h.savedThreads;
        }),
      );
      expect(
        (yield* Ref.get(saved)).map((snapshot) => [
          snapshot.snapshotSequence,
          snapshot.thread.title,
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
        httpSnapshot: Option.some({
          thread: BASE_THREAD,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
        }),
        resumeCache,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* awaitThreadState(first.observed, (value) => value.status === "live");
      const applying = yield* Deferred.make<void>();
      const update = titleUpdated("Not applied", 8);
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      Object.defineProperty(update.event.payload, "title", {
        get: () => {
          Deferred.doneUnsafe(applying, Exit.void);
          return "Not applied";
        },
      });
      // The reducer reads the title after it advances the cursor. Hold only
      // the data write so closing the scope interrupts that exact interval.
      yield* first.threadState.semaphore.take(1);
      yield* Queue.offer(first.inputs, update);
      yield* Deferred.await(applying);
      yield* Scope.close(scope, Exit.void);
      yield* first.threadState.semaphore.release(1);

      const resumed = yield* makeHarness({ resumeCache });
      const state = yield* awaitThreadState(resumed.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data).title).toBe(BASE_THREAD.title);
      expect(yield* Ref.get(resumed.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(first.savedThreads)).toEqual([
        {
          thread: BASE_THREAD,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
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
      const old = yield* makeHarness({ cached: BASE_THREAD, resumeCache }).pipe(
        Effect.provideService(Scope.Scope, oldScope),
      );
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.title === "Successor title",
      );
      yield* Queue.offer(old.inputs, titleUpdated("Old scope title", 8));
      yield* awaitThreadState(
        old.observed,
        (value) => Option.getOrNull(value.data)?.title === "Old scope title",
      );
      yield* Scope.close(oldScope, Exit.void);

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).title).toBe("Successor title");
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
      const response = yield* Deferred.make<Option.Option<OrchestrationThreadDetailSnapshot>>();
      const oldFiber = yield* makeHarness({
        resumeCache,
        loadCached: Deferred.succeed(loading, undefined).pipe(
          Effect.andThen(Deferred.await(response)),
        ),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(loading);
      const successor = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
      yield* awaitThreadState(successor.observed, (value) => value.status === "live");
      yield* Deferred.succeed(
        response,
        Option.some({ snapshotSequence: 3, thread: { ...BASE_THREAD, title: "Old disk data" } }),
      );
      const old = yield* Fiber.join(oldFiber);
      yield* awaitThreadState(old.observed, (value) => value.status === "live");

      expect(resumeCache.snapshot?.sequence).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).title).toBe(BASE_THREAD.title);
    }),
  );

  it.effect("does not let an old deletion remove its successor's persisted cache", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const old = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.title === "Successor title",
      );
      const update = deleted();
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      yield* Queue.offer(old.inputs, { ...update, event: { ...update.event, sequence: 8 } });
      yield* awaitThreadState(old.observed, (value) => value.status === "deleted");

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(yield* Ref.get(old.removedThreads)).toEqual([]);
    }),
  );

  for (const delivery of ["event", "snapshot"] as const) {
    it.effect(`preserves successor persistence after an obsolete archive ${delivery}`, () =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const persisted = yield* Deferred.make<void>();
        const old = yield* makeHarness({
          cached: BASE_THREAD,
          resumeCache,
          saveThread: (_environmentId, saved) =>
            saved.thread.title === "Successor still persists"
              ? Deferred.succeed(persisted, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        yield* awaitThreadState(old.observed, (value) => value.status === "live");
        const successor = yield* makeHarness({ resumeCache, cache: old.cache });
        yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
        yield* awaitThreadState(
          successor.observed,
          (value) => Option.getOrNull(value.data)?.title === "Successor title",
        );
        const update = archived();
        if (update.kind !== "event") return yield* Effect.die("Expected an event");
        yield* Queue.offer(
          old.inputs,
          delivery === "event"
            ? { ...update, event: { ...update.event, sequence: 8 } }
            : snapshot({ ...BASE_THREAD, archivedAt: "2026-04-01T02:00:00.000Z" }),
        );
        yield* awaitThreadState(
          old.observed,
          (value) => Option.getOrNull(value.data)?.archivedAt != null,
        );
        // A later item confirms the prior archive finished applying.
        yield* Queue.offer(old.inputs, titleUpdated("Old scope processed archive", 10));
        yield* awaitThreadState(
          old.observed,
          (value) => Option.getOrNull(value.data)?.title === "Old scope processed archive",
        );
        expect(resumeCache.snapshot?.sequence).toBe(9);
        expect(Option.getOrThrow(resumeCache.snapshot!.state.data).title).toBe("Successor title");
        expect(yield* Ref.get(old.removedThreads)).toEqual([]);
        expect(isCachedThreadEvicted(old.cache, TARGET.environmentId, THREAD_ID)).toBe(false);

        yield* Queue.offer(successor.inputs, titleUpdated("Successor still persists", 11));
        yield* awaitThreadState(
          successor.observed,
          (value) => Option.getOrNull(value.data)?.title === "Successor still persists",
        );
        yield* TestClock.adjust("500 millis");
        yield* Deferred.await(persisted);
      }),
    );

    it.effect(`preserves the successor tombstone after an obsolete unarchive ${delivery}`, () =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const old = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
        yield* awaitThreadState(old.observed, (value) => value.status === "live");
        const successor = yield* makeHarness({ resumeCache, cache: old.cache });
        yield* awaitThreadState(successor.observed, (value) => value.status === "live");
        yield* evictCachedThread(old.cache, TARGET.environmentId, THREAD_ID);
        const generation = cachedThreadGeneration(old.cache, TARGET.environmentId, THREAD_ID);
        const update = unarchived();
        if (update.kind !== "event") return yield* Effect.die("Expected an event");
        yield* Queue.offer(
          old.inputs,
          delivery === "event"
            ? { ...update, event: { ...update.event, sequence: 8 } }
            : snapshot({ ...BASE_THREAD, title: "Obsolete active snapshot" }),
        );
        yield* awaitThreadState(old.observed, (value) => {
          const thread = Option.getOrNull(value.data);
          return delivery === "event"
            ? thread?.updatedAt === "2026-04-01T03:00:00.000Z"
            : thread?.title === "Obsolete active snapshot";
        });
        yield* Queue.offer(old.inputs, titleUpdated("Old scope processed unarchive", 10));
        yield* awaitThreadState(
          old.observed,
          (value) => Option.getOrNull(value.data)?.title === "Old scope processed unarchive",
        );
        expect(isCachedThreadEvicted(old.cache, TARGET.environmentId, THREAD_ID)).toBe(true);
        expect(cachedThreadGeneration(old.cache, TARGET.environmentId, THREAD_ID)).toBe(generation);
        expect(resumeCache.invalidated).toBe(true);
        expect(resumeCache.snapshot).toBeUndefined();
      }),
    );
  }

  it.effect("retains a deletion instead of restoring the old disk snapshot", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
          const update = deleted();
          if (update.kind !== "event") return yield* Effect.die("Expected an event");
          yield* Queue.offer(first.inputs, { ...update, event: { ...update.event, sequence: 8 } });
          yield* awaitThreadState(first.observed, (value) => value.status === "deleted");
        }),
      );
      const resumed = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
      const state = yield* awaitThreadState(
        resumed.observed,
        (value) => value.status === "deleted",
      );
      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(resumed.loaderCalls)).toBe(0);
    }),
  );

  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });

      // The warm cache reaches live from the cached data, and a live event
      // applies on top of it.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      // The subscription resumed from the cached sequence and never fetched the
      // full snapshot over HTTP.
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(2);
    }),
  );

  it.effect("does not persist active thread snapshots during streaming or teardown", () =>
    Effect.gen(function* () {
      const savedThreads = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: ACTIVE_THREAD });
          yield* awaitThreadState(
            harness.observed,
            (value) =>
              value.status === "live" &&
              Option.isSome(value.data) &&
              value.data.value.session?.status === "running",
          );

          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;

          expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
          return harness.savedThreads;
        }),
      );

      expect(yield* Ref.get(savedThreads)).toEqual([]);
    }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpThread: OrchestrationThread = { ...BASE_THREAD, title: "HTTP title" };
      const harness = yield* makeHarness({
        httpSnapshot: Option.some({ snapshotSequence: 1, thread: httpThread }),
      });
      // No socket snapshot is pushed; only a live event arrives over the socket.
      // It can only be applied if the HTTP snapshot already seeded the thread.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      // Cold cache: the full snapshot was loaded over HTTP and the socket
      // resumed from that snapshot's sequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("removes cached data when the thread is archived and does not persist it again", () =>
    Effect.gen(function* () {
      const savedThreads = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: BASE_THREAD });
          yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
          yield* Queue.offer(harness.inputs, archived());

          const state = yield* awaitThreadState(
            harness.observed,
            (value) => Option.isSome(value.data) && value.data.value.archivedAt !== null,
          );
          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;

          expect(Option.getOrThrow(state.data).archivedAt).toBe("2026-04-01T02:00:00.000Z");
          expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
          expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
          return harness.savedThreads;
        }),
      );

      expect(yield* Ref.get(savedThreads)).toEqual([]);
    }),
  );

  it.effect("retries a missing archived thread so it can observe unarchive", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, archived());
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.archivedAt !== null,
      );

      yield* Queue.offer(harness.inputs, new Error("thread was moved to cold storage"));
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));
      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      yield* Queue.offer(harness.inputs, unarchived());
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.archivedAt === null,
      );
      expect(Option.getOrThrow(state.data).archivedAt).toBeNull();
    }),
  );

  it.effect("removes cached data when an archived thread arrives in a snapshot", () =>
    Effect.gen(function* () {
      const archivedThread = {
        ...BASE_THREAD,
        archivedAt: "2026-04-01T02:00:00.000Z",
      };
      const harness = yield* makeHarness({ cached: BASE_THREAD });

      yield* Queue.offer(harness.inputs, snapshot(archivedThread));
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.archivedAt !== null,
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).archivedAt).toBe("2026-04-01T02:00:00.000Z");
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
    }),
  );

  it.effect("does not restore an out-of-band cache eviction from queued or teardown writes", () =>
    Effect.gen(function* () {
      const savedThreads = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: BASE_THREAD });
          yield* Queue.offer(
            harness.inputs,
            titleUpdated("Stale pending title", CACHED_SNAPSHOT_SEQUENCE + 1),
          );
          yield* awaitThreadState(
            harness.observed,
            (value) =>
              Option.isSome(value.data) && value.data.value.title === "Stale pending title",
          );

          yield* evictCachedThread(harness.cache, TARGET.environmentId, THREAD_ID);
          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;

          expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
          expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
          return harness.savedThreads;
        }),
      );

      expect(yield* Ref.get(savedThreads)).toEqual([]);
    }),
  );

  for (const operation of ["evict", "revive"] as const) {
    it.effect(`rechecks ownership when a queued cache ${operation} acquires its permit`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const block = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const harness = yield* makeHarness({
          cached: BASE_THREAD,
          ...(operation === "evict" ? { saveThread: () => block } : { removeThread: () => block }),
        });
        yield* awaitThreadState(harness.observed, (value) => value.status === "live");
        const holding = yield* (
          operation === "evict"
            ? persistCachedThread(
                harness.cache,
                TARGET.environmentId,
                { snapshotSequence: 7, thread: BASE_THREAD },
                cachedThreadGeneration(harness.cache, TARGET.environmentId, THREAD_ID),
              )
            : evictCachedThread(harness.cache, TARGET.environmentId, THREAD_ID)
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        let ownsCache = true;
        const queued = yield* (
          operation === "evict"
            ? evictCachedThread(harness.cache, TARGET.environmentId, THREAD_ID, () => ownsCache)
            : reviveCachedThread(harness.cache, TARGET.environmentId, THREAD_ID, () => ownsCache)
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const generation = cachedThreadGeneration(harness.cache, TARGET.environmentId, THREAD_ID);
        ownsCache = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holding);
        yield* Fiber.join(queued);
        expect(cachedThreadGeneration(harness.cache, TARGET.environmentId, THREAD_ID)).toBe(
          generation,
        );
        expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, THREAD_ID)).toBe(
          operation === "revive",
        );
        expect(yield* Ref.get(harness.removedThreads)).toEqual(
          operation === "revive" ? [THREAD_ID] : [],
        );
      }),
    );
  }

  it.effect("retries a failed archive eviction for the current cache owner", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const removed = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        resumeCache: { snapshot: undefined, owner: undefined },
        removeThread: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(
                  new Persistence.ConnectionPersistenceError({
                    operation: "remove-thread",
                    message: "Temporary cache removal failure",
                  }),
                )
              : Deferred.succeed(removed, undefined).pipe(Effect.asVoid);
          }),
      });
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* Queue.offer(
        harness.inputs,
        snapshot({ ...BASE_THREAD, archivedAt: "2026-04-01T02:00:00.000Z" }),
      );
      yield* Queue.offer(harness.inputs, titleUpdated("First eviction processed", 9));
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.getOrNull(value.data)?.title === "First eviction processed",
      );
      expect(attempts).toBe(1);
      yield* Queue.offer(
        harness.inputs,
        snapshot({ ...BASE_THREAD, archivedAt: "2026-04-01T02:00:00.000Z" }),
      );
      yield* Deferred.await(removed);
      expect(attempts).toBe(2);
    }),
  );

  it.effect("keeps an active cache write valid when revival is already satisfied", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const generation = cachedThreadGeneration(harness.cache, TARGET.environmentId, THREAD_ID);

      yield* reviveCachedThread(harness.cache, TARGET.environmentId, THREAD_ID);
      yield* persistCachedThread(
        harness.cache,
        TARGET.environmentId,
        { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, thread: BASE_THREAD },
        generation,
      );

      expect(yield* Ref.get(harness.savedThreads)).toEqual([
        { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, thread: BASE_THREAD },
      ]);
    }),
  );

  it.effect("rejects a pre-eviction write after cache revival", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const staleGeneration = cachedThreadGeneration(
        harness.cache,
        TARGET.environmentId,
        THREAD_ID,
      );

      yield* evictCachedThread(harness.cache, TARGET.environmentId, THREAD_ID);
      yield* reviveCachedThread(harness.cache, TARGET.environmentId, THREAD_ID);
      yield* persistCachedThread(
        harness.cache,
        TARGET.environmentId,
        { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, thread: BASE_THREAD },
        staleGeneration,
      );
      expect(yield* Ref.get(harness.savedThreads)).toEqual([]);

      const revivedGeneration = cachedThreadGeneration(
        harness.cache,
        TARGET.environmentId,
        THREAD_ID,
      );
      yield* persistCachedThread(
        harness.cache,
        TARGET.environmentId,
        { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, thread: BASE_THREAD },
        revivedGeneration,
      );
      expect(yield* Ref.get(harness.savedThreads)).toEqual([
        { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, thread: BASE_THREAD },
      ]);
    }),
  );

  it.effect("rejects a write captured while the cache is evicted after revival", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });

      yield* evictCachedThread(harness.cache, TARGET.environmentId, THREAD_ID);
      const evictedGeneration = cachedThreadGeneration(
        harness.cache,
        TARGET.environmentId,
        THREAD_ID,
      );

      yield* reviveCachedThread(harness.cache, TARGET.environmentId, THREAD_ID);
      yield* persistCachedThread(
        harness.cache,
        TARGET.environmentId,
        { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, thread: BASE_THREAD },
        evictedGeneration,
      );

      expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
    }),
  );

  it.effect("persists thread detail again after an authoritative unarchive event", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, archived());
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.archivedAt !== null,
      );

      yield* Queue.offer(harness.inputs, unarchived());
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.archivedAt === null,
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread.archivedAt).toBeNull();
    }),
  );

  it.effect("persists thread detail again after an authoritative active snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          archivedAt: "2026-04-01T02:00:00.000Z",
        }),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.archivedAt !== null,
      );

      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Restored from snapshot",
          updatedAt: "2026-04-01T03:00:00.000Z",
        }),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.title === "Restored from snapshot",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread).toMatchObject({
        title: "Restored from snapshot",
        archivedAt: null,
      });
    }),
  );

  it.effect("does not resurrect a deleted thread when the app returns to the foreground", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        completionMarker: true,
        httpSnapshot: Option.some({
          snapshotSequence: 4,
          thread: { ...BASE_THREAD, title: "Stale HTTP thread" },
        }),
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      const latest = yield* Ref.get(harness.latest);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(latest.status).toBe("deleted");
      expect(Option.isNone(latest.data)).toBe(true);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
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
          ...BASE_THREAD,
          title: "Recovered thread",
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Recovered thread",
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
          ...BASE_THREAD,
          title: "Materialized thread",
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
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
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
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

  it.effect("keeps replayed updates synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
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
          value.data.value.title === "Caught-up title",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).title).toBe("Caught-up title");
    }),
  );

  it.effect("resumes replacement sessions from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
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
          value.data.value.title === "Latest title",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
    }),
  );

  it.effect("resubscribes on app foreground from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
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
          value.data.value.title === "Latest title",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      const synchronizing = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(synchronizing.status).toBe("synchronizing");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).title).toBe("Latest title");

      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);

      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);
    }),
  );

  it.effect("evicts cached data without repersisting a body archived in a batch", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const harness = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* Queue.offerAll(harness.inputs, [
        titleUpdated("Settled before archive", CACHED_SNAPSHOT_SEQUENCE + 1),
        archived(CACHED_SNAPSHOT_SEQUENCE + 2),
      ]);
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.getOrNull(value.data)?.archivedAt != null,
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, THREAD_ID)).toBe(true);
      expect(resumeCache.snapshot).toBeUndefined();
    }),
  );

  it.effect("revives and persists cached data after an unarchive in a batch", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const harness = yield* makeHarness({ cached: BASE_THREAD, resumeCache });
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* Queue.offer(harness.inputs, archived(CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.getOrNull(value.data)?.archivedAt != null,
      );
      yield* Queue.offerAll(harness.inputs, [
        unarchived(CACHED_SNAPSHOT_SEQUENCE + 2),
        titleUpdated("Restored in batch", CACHED_SNAPSHOT_SEQUENCE + 3),
      ]);
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.getOrNull(value.data)?.title === "Restored in batch",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect(isCachedThreadEvicted(harness.cache, TARGET.environmentId, THREAD_ID)).toBe(false);
      expect((yield* Ref.get(harness.savedThreads)).at(-1)).toMatchObject({
        snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 3,
        thread: { title: "Restored in batch", archivedAt: null },
      });
      expect(resumeCache.invalidated).toBe(false);
    }),
  );

  it.effect(
    "persists a turn that settles mid-batch when the next turn starts in the same batch",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ cached: ACTIVE_THREAD });
        yield* awaitThreadState(harness.observed, (value) => value.status === "live");
        const before = yield* Ref.get(harness.stateChangeCount);

        // Both events arrive in one transport batch: the session settles and the
        // next turn starts before the fold publishes.
        yield* Queue.offerAll(harness.inputs, [
          sessionSet("ready", "turn-1", CACHED_SNAPSHOT_SEQUENCE + 1),
          sessionSet("running", "turn-2", CACHED_SNAPSHOT_SEQUENCE + 2),
        ]);
        yield* awaitThreadState(
          harness.observed,
          (value) =>
            Option.isSome(value.data) &&
            value.data.value.session?.activeTurnId === TurnId.make("turn-2"),
        );
        expect((yield* Ref.get(harness.stateChangeCount)) - before).toBe(1);
        yield* TestClock.adjust("500 millis");
        yield* Effect.yieldNow;

        // The settled state reached the cache under its own sequence even
        // though the batch ended on a running session.
        const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
        expect(saved?.thread.session?.status).toBe("ready");
        expect(saved?.snapshotSequence).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      }),
  );
});
