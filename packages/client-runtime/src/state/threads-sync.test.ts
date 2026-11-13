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
import { BASE_PROJECTION, CACHED_SNAPSHOT_SEQUENCE, PENDING_QUESTION, PREPARED, TARGET, THREAD_ID, awaitThreadState, deleted, makeHarness, questionResolved, snapshot, synchronized, testSession, titleUpdated } from "./threads-sync.helpers2.testkit.ts";
import type { TestThreadInput } from "./threads-sync.helpers2.testkit.ts";

describe("EnvironmentThreads", () => {
  it.effect("discards an oversized version-4 cache and requests a fresh bounded snapshot", () =>
    Effect.gen(function* () {
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make("old-unbounded-cache-item"),
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
        startedAt: BASE_PROJECTION.updatedAt,
        completedAt: BASE_PROJECTION.updatedAt,
        updatedAt: BASE_PROJECTION.updatedAt,
        type: "system_notice",
        message: "x".repeat(1_100_000),
      };
      const schema = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
      const encoded = yield* Schema.encodeEffect(schema)({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        environmentId: TARGET.environmentId,
        threadId: THREAD_ID,
        snapshot: {
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          projection: { ...BASE_PROJECTION, turnItems: [item] },
        },
      });
      const stale = encoded.replace(
        `"schemaVersion":${ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION}`,
        '"schemaVersion":4',
      );
      let discarded = false;
      const h = yield* makeHarness({
        loadCached: decodeOrDiscardOrchestrationCache(
          Schema.decodeEffect(schema)(stale).pipe(
            Effect.map((stored) => Option.some(stored.snapshot)),
          ),
          Effect.sync(() => {
            discarded = true;
          }),
        ),
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
          history: { historyCursor: "fresh-bounded-cursor", hasMoreHistory: true },
        },
      });
      const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
      expect(discarded).toBe(true);
      expect(yield* Ref.get(h.loaderCalls)).toBe(1);
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(state.history.historyCursor).toBe("fresh-bounded-cursor");
      expect(state.history.hasMoreHistory).toBe(true);
    }),
  );

  it.effect.each(["read failure", "cache miss"] as const)(
    "loads the server thread after a %s",
    (scenario) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          loadCached:
            scenario === "cache miss"
              ? Effect.succeedNone
              : Effect.fail(
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
        expect(yield* SubscriptionRef.get(h.subscriptionCount)).toBe(1);
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
      const announced: ThreadRequestsResolved[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => onThreadRequestsResolved((event) => announced.push(event))),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const oldScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const old = yield* makeHarness({
        cached: { ...BASE_PROJECTION, runtimeRequests: [PENDING_QUESTION] },
        resumeCache,
      }).pipe(Effect.provideService(Scope.Scope, oldScope));
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 10));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      announced.length = 0;
      yield* Queue.offerAll(old.inputs, [questionResolved(8), titleUpdated("Old scope title", 9)]);
      yield* awaitThreadState(
        old.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Old scope title",
      );
      yield* Scope.close(oldScope, Exit.void);

      // Draft pruners would delete the answer the successor still waits on.
      expect(announced).toEqual([]);
      expect(resumeCache.snapshot?.sequence).toBe(10);
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

  it.effect("asks the server again after an HTTP miss, since the thread may not exist yet", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness({ httpSnapshot: { _tag: "missing" }, resumeCache });
          yield* awaitThreadState(first.observed, (value) => value.status === "deleted");
        }),
      );
      const resumed = yield* makeHarness({
        resumeCache,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
        },
      });
      const state = yield* awaitThreadState(resumed.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(resumed.loaderCalls)).toBe(1);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });

      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      // Readers compare this to a command's commit sequence; it moves with the data it describes.
      expect(live.sequence).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );
});

