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
          cacheKind === "retained" ? { resumeCache } : { loadCached: Effect.succeedSome(saved!) },
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
      expect(yield* SubscriptionRef.get(harness.subscriptionCount)).toBe(1);
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
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count >= 2),
        Stream.runHead,
      );
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
      expect(yield* SubscriptionRef.get(harness.subscriptionCount)).toBe(2);
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

  it.effect("announces request resolution only from a synchronized projection", () =>
    Effect.gen(function* () {
      const announced = yield* Queue.unbounded<ThreadRequestsResolved>();
      yield* Effect.acquireRelease(
        Effect.sync(() => onThreadRequestsResolved((event) => Queue.offerUnsafe(announced, event))),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const harness = yield* makeHarness({
        cached: { ...BASE_PROJECTION, runtimeRequests: [PENDING_QUESTION] },
        completionMarker: true,
      });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );

      // Answered on another device while this client was away.
      yield* Queue.offerAll(harness.inputs, [
        questionResolved(CACHED_SNAPSHOT_SEQUENCE + 1),
        synchronized(),
      ]);

      expect(yield* Queue.take(announced)).toEqual({
        environmentId: TARGET.environmentId,
        threadId: THREAD_ID,
        pendingRequestIds: [],
      });
      expect(yield* Queue.size(announced)).toBe(0);
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
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count >= 2),
        Stream.runHead,
      );
      expect(yield* SubscriptionRef.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 4);
    }),
  );
});
