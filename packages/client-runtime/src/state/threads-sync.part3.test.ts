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

  describe("cached work (#18188)", () => {
    const at = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const parentThreadId = ThreadId.make("thread:parent");
    const command = (
      id: string,
      status: "running" | "completed",
      exitCode?: number,
      ordinal = id === "older-command" ? 1 : 2,
    ): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> => ({
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
    const cachedItem = (item: OrchestrationV2TurnItem) => ({
      ...BASE_PROJECTION,
      turnItems: [item],
      visibleTurnItems: [localRow(item, 0)],
    });
    const historyPage = (
      request: Parameters<typeof HttpClientResponse.fromWeb>[0],
      items: ReadonlyArray<ReturnType<typeof localRow>>,
      nextCursor: string | null,
    ) =>
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          items,
          nextCursor,
          hasMoreHistory: nextCursor !== null,
        }),
      );
    it.effect("loads a long unwrapped turn through its user message and resumes failed pages", () =>
      Effect.gen(function* () {
        const prompt = {
          ...command("prompt", "completed", 0, 0),
          type: "user_message" as const,
          messageId: MessageId.make("prompt"),
          inputIntent: "turn_start" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
          text: "Do the work",
          attachments: [],
        };
        const work = Array.from({ length: 1_000 }, (_, index) =>
          command(`work-${index + 1}`, "completed", 0, index + 1),
        );
        const older = [prompt, ...work.slice(0, -1)];
        const tail = work.at(-1)!;
        const requests: string[] = [];
        let failed = false;
        const harness = yield* makeHarness({
          cached: cachedItem(tail),
          cachedHistory: { historyCursor: "1000", hasMoreHistory: true },
          historyHttpClient: HttpClient.make((request, url) => {
            const cursor = url.searchParams.get("cursor")!;
            requests.push(cursor);
            if (cursor === "before-user") return Effect.succeed(historyPage(request, [], cursor));
            if (cursor === "925" && !failed) {
              failed = true;
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
              );
            }
            const end = Number(cursor);
            expect(Number.isFinite(end)).toBe(true);
            const start = Math.max(0, end - 75);
            return Effect.succeed(
              historyPage(
                request,
                older.slice(start, end).map(localRow),
                start === 0 ? "before-user" : String(start),
              ),
            );
          }),
        });
        expect((yield* harness.loadEarlier())._tag).toBe("error");
        expect(requests).toEqual(["1000", "925"]);
        expect(yield* harness.loadEarlier()).toEqual({ _tag: "loaded" });
        const state = yield* SubscriptionRef.get(harness.threadState);
        expect(
          Option.getOrThrow(state.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([prompt, ...work].map((item) => item.id));
        expect(state.history).toMatchObject({
          historyCursor: "before-user",
          hasMoreHistory: true,
          loading: false,
        });
        expect(requests.slice(1, 3)).toEqual(["925", "925"]);
        expect(yield* harness.loadEarlier()).toEqual({
          _tag: "error",
          message: "History did not advance.",
        });
        expect((yield* SubscriptionRef.get(harness.threadState)).history.loading).toBe(false);
      }),
    );
    it.effect("loads deferred work on demand and resumes a failed page", () =>
      Effect.gen(function* () {
        const anchor = {
          ...command("anchor", "completed", 0, 1),
          deferredWork: { cursor: "first", itemCount: 3, lastOrdinal: 3 },
        };
        const requests: string[] = [];
        let failed = false;
        const harness = yield* makeHarness({
          cached: cachedItem(anchor),
          cachedHistory: { historyCursor: "older", hasMoreHistory: true },
          historyHttpClient: HttpClient.make((request, url) => {
            expect(url.searchParams.get("view")).toBe("work");
            const cursor = url.searchParams.get("cursor")!;
            requests.push(cursor);
            if (cursor === "second" && !failed) {
              failed = true;
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("Unavailable", { status: 503 })),
              );
            }
            return Effect.succeed(
              historyPage(
                request,
                [
                  localRow(
                    command(`work-${cursor}`, "completed", 0, cursor === "first" ? 3 : 2),
                    0,
                  ),
                ],
                cursor === "first" ? "second" : null,
              ),
            );
          }),
        });
        expect(requests).toEqual([]);
        expect((yield* harness.loadWork(anchor.id))._tag).toBe("error");
        const partial = Option.getOrThrow((yield* SubscriptionRef.get(harness.threadState)).data);
        expect(partial.visibleTurnItems[0]?.item.deferredWork?.cursor).toBe("second");
        expect(yield* harness.loadWork(anchor.id)).toEqual({ _tag: "loaded" });
        const state = yield* SubscriptionRef.get(harness.threadState);
        expect(
          Option.getOrThrow(state.data).visibleTurnItems.map((row) => row.item.ordinal),
        ).toEqual([1, 2, 3]);
        expect(state.history.historyCursor).toBe("older");
        expect(requests).toEqual(["first", "second", "second"]);
      }),
    );

    it.effect.each(["deferred", "complete"] as const)(
      "settles a replaced work request when the new snapshot is %s",
      (mode) =>
        Effect.gen(function* () {
          const anchor = {
            ...command("anchor", "completed"),
            deferredWork: { cursor: "before", itemCount: 80, lastOrdinal: 80 },
          };
          const asked = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const harness = yield* makeHarness({
            cached: cachedItem(anchor),
            historyHttpClient: HttpClient.make((request) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(asked, undefined);
                yield* Deferred.await(release);
                return historyPage(request, [], null);
              }),
            ),
          });
          const loading = yield* harness.loadWork(anchor.id).pipe(Effect.forkChild);
          yield* Deferred.await(asked);
          const replacement =
            mode === "deferred"
              ? { ...anchor, deferredWork: { ...anchor.deferredWork, cursor: "after" } }
              : command("anchor", "completed");
          yield* Queue.offer(
            harness.inputs,
            snapshot(
              {
                ...BASE_PROJECTION,
                thread: { ...BASE_PROJECTION.thread, title: "Replacement" },
                turnItems: [replacement],
                visibleTurnItems: [localRow(replacement, 0)],
              },
              CACHED_SNAPSHOT_SEQUENCE + 1,
            ),
          );
          yield* awaitThreadState(
            harness.observed,
            (value) => Option.getOrNull(value.data)?.thread.title === "Replacement",
          );
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(loading))._tag).toBe(mode === "deferred" ? "error" : "noop");
        }),
    );

    it.effect("does not mark replacement history loading when a queued request becomes stale", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          cached: BASE_PROJECTION,
          cachedHistory: { historyCursor: "older", hasMoreHistory: true },
          historyHttpClient: HttpClient.make((request) =>
            Effect.succeed(historyPage(request, [], null)),
          ),
        });
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const replacement = yield* SubscriptionRef.updateEffect(harness.threadState, (latest) =>
          Deferred.succeed(held, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ ...latest, history: { ...latest.history, historyCursor: "replacement" } }),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(held);
        const dispatcher = new Scheduler.MixedScheduler("sync").makeDispatcher();
        const loading = yield* harness.loadEarlier().pipe(
          Effect.forkChild({ startImmediately: true }),
          Effect.provideService(Scheduler.Scheduler, {
            executionMode: "sync",
            shouldYield: () => false,
            makeDispatcher: () => dispatcher,
          }),
        );
        dispatcher.flush();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(replacement);
        dispatcher.flush();
        expect(yield* Fiber.join(loading)).toEqual({ _tag: "noop" });
        expect((yield* SubscriptionRef.get(harness.threadState)).history).toMatchObject({
          historyCursor: "replacement",
          loading: false,
        });
      }),
    );

    it.effect("loads targeted messages without fetching unrelated deferred work", () =>
      Effect.gen(function* () {
        const anchor = {
          ...command("anchor", "completed"),
          deferredWork: { cursor: "work", itemCount: 80, lastOrdinal: 80 },
        };
        const message = {
          ...command("older-message", "completed"),
          type: "assistant_message" as const,
          messageId: MessageId.make("older-message"),
          text: "Older response",
          streaming: false,
        };
        const views: Array<string | null> = [];
        const harness = yield* makeHarness({
          cached: cachedItem(anchor),
          cachedHistory: { historyCursor: "older", hasMoreHistory: true },
          historyHttpClient: HttpClient.make((request, url) => {
            views.push(url.searchParams.get("view"));
            return Effect.succeed(
              url.searchParams.get("view") === "work"
                ? HttpClientResponse.fromWeb(request, new Response("Unavailable", { status: 503 }))
                : historyPage(request, [localRow(message, 0)], null),
            );
          }),
        });
        expect(yield* harness.loadEarlier(message.messageId)).toEqual({ _tag: "loaded" });
        const state = yield* SubscriptionRef.get(harness.threadState);
        expect(
          Option.getOrThrow(state.data).visibleTurnItems.some(
            (row) => row.sourceItemId === message.id,
          ),
        ).toBe(true);
        expect(views).toEqual(["conversation", null]);
      }),
    );

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
              sequence: CACHED_SNAPSHOT_SEQUENCE,
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
});
