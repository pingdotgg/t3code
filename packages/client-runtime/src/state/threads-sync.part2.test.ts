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
        const prompt = {
          ...message,
          id: "item:older-prompt",
          messageId: "message:older-prompt",
          ordinal: 0,
          type: "user_message",
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
          attachments: [],
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
              if (url.searchParams.get("cursor") === "next-cursor")
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    snapshotSequence: 14,
                    items: [projected(prompt, 0)],
                    nextCursor: "before-prompt",
                    hasMoreHistory: true,
                  }),
                );
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
          historyCursor: mode === "retry" ? "before-prompt" : "next-cursor",
          error: null,
          latestLocalTurnOrdinal: 47,
        });
        expect(
          Option.getOrThrow(complete.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual(
          mode === "retry" ? [prompt.id, message.id, activity.id] : [message.id, activity.id],
        );
        expect(Option.getOrThrow(complete.data).turnItems).toHaveLength(mode === "retry" ? 3 : 2);
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
});

