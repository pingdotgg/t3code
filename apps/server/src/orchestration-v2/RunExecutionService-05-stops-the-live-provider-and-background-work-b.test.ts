import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ChatAttachmentId,
  ChatFileAttachment,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

import {
  backgroundScenarioIds,
  backgroundTurnItemEvent,
  backgroundTurnItemEventForRun,
  captureRootRunTermination,
  childBackgroundTurnItemEvent,
  childThreadCreatedEvent,
  driver,
  layerRunExecutionTest,
  layerTurnItemPositionsTest,
  makeLinkedChildTurnItemFixture,
  makeRunOwnedSubagentChildNodeFixture,
  makeRunOwnedSubagentFixture,
  makeRunOwnedSubagentNodeFixture,
  makeRunOwnedSubagentTurnItemFixture,
  rootAppThread,
  rootTerminalEvent,
  runBackgroundItemScenario,
  subagentEvent,
} from "./RunExecutionService-fixtures.testkit.ts";
import type { BackgroundScenarioIds } from "./RunExecutionService-fixtures.testkit.ts";

it.effect.each(["failure", "defect", "interrupt-failure", "ownership-lost"] as const)(
  "stops the live provider and background work before settling an ingestion %s",
  (failureMode) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const backgroundWorkRunning = yield* Ref.make(true);
      const backgroundWorkAtFinalization = yield* Ref.make<boolean | null>(null);
      const now = yield* DateTime.now;
      const interrupts = yield* Ref.make<
        ReadonlyArray<ProviderAdapter.ProviderAdapterV2InterruptInput>
      >([]);
      const ids = backgroundScenarioIds(`ingestion:${failureMode}`);
      const { written, observed, finalEvents } = yield* captureRootRunTermination({
        key: `ingestion:${failureMode}`,
        initialProviderTurnId: null,
        rejectTerminalWrite: failureMode === "ownership-lost",
        shouldFinalizeRun: () => Effect.succeed(true),
        startTurn: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(stopped))),
        events: () =>
          Stream.unwrap(
            Deferred.await(started).pipe(
              Effect.as(
                Stream.make({
                  type: "provider_turn.updated" as const,
                  driver,
                  providerTurn: {
                    id: ids.rootProviderTurnId,
                    providerThreadId: ids.providerThreadId,
                    nodeId: ids.rootNodeId,
                    runAttemptId: ids.attemptId,
                    nativeTurnRef: null,
                    ordinal: 1,
                    status: "running" as const,
                    startedAt: now,
                    completedAt: null,
                  },
                }),
              ),
            ),
          ),
        ingestNormalized: () => {
          const error = new ProviderEventIngestor.ProviderEventPublishError({
            providerSessionId: ProviderSessionId.make(`session:${failureMode}`),
            eventCount: 1,
            cause: toPersistenceSqlError("OrchestrationEventStore.appendAgentEvents:insert")(
              new SqlError({
                reason: classifySqliteError(
                  Object.assign(new Error("unable to open database file"), { errcode: 14 }),
                ),
              }),
            ),
          });
          return failureMode === "defect" ? Effect.die(error) : Effect.fail(error);
        },
        interruptTurn: (input) =>
          Ref.update(interrupts, (current) => [...current, input]).pipe(
            Effect.andThen(
              input.requestRuntimeRestart === true && failureMode !== "interrupt-failure"
                ? Ref.set(backgroundWorkRunning, false)
                : Effect.void,
            ),
            Effect.andThen(Deferred.succeed(stopped, undefined)),
            Effect.andThen(
              failureMode === "interrupt-failure"
                ? Effect.fail(
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: input.providerThread.id,
                      providerTurnId: input.providerTurnId,
                      cause: "provider already exited",
                    }),
                  )
                : Effect.void,
            ),
          ),
        beforeTerminalWrite: () =>
          Effect.gen(function* () {
            const calls = yield* Ref.get(interrupts);
            assert.equal(calls.length, 1);
            assert.equal(calls[0]?.providerTurnId, ids.rootProviderTurnId);
            assert.equal(calls[0]?.providerThread.id, ids.providerThreadId);
            yield* Ref.set(backgroundWorkAtFinalization, yield* Ref.get(backgroundWorkRunning));
            return true;
          }),
      });
      if (failureMode === "ownership-lost") {
        assert.deepEqual(finalEvents, []);
        assert.deepEqual(observed, []);
      } else {
        assert.equal(
          yield* Ref.get(backgroundWorkAtFinalization),
          failureMode === "interrupt-failure",
        );
        assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
        const error = written.find((item) => item.type === "error");
        assert.include(error?.failure.message ?? "", "(SQLITE_CANTOPEN)");
        const repaired = finalEvents.find((event) => event.type === "provider-turn.updated");
        if (failureMode === "interrupt-failure") {
          assert.isUndefined(repaired);
        } else {
          assert.equal(repaired?.payload.id, ids.rootProviderTurnId);
          assert.equal(repaired?.payload.status, "interrupted");
          assert.isNotNull(repaired?.payload.completedAt);
        }
      }
    }),
);

it.effect.each([
  { status: "completed", failure: "later-stream", interrupt: "succeeds" },
  { status: "failed", failure: "later-stream", interrupt: "succeeds" },
  { status: "completed", failure: "terminal-ingest", interrupt: "succeeds" },
  { status: "completed", failure: "terminal-ingest", interrupt: "fails" },
] as const)(
  "stores a $status root provider turn snapshot after a $failure failure only if the interrupt succeeds (it $interrupt)",
  ({ status, failure, interrupt }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const terminalAt = DateTime.subtract(now, { seconds: 1 });
      const key = `terminal-snapshot:${status}:${failure}:${interrupt}`;
      const durableTurns = yield* Ref.make<
        ReadonlyMap<ProviderTurnId, OrchestrationV2ProviderTurn>
      >(new Map());
      const persist = (turn: OrchestrationV2ProviderTurn) =>
        Ref.update(durableTurns, (current) => new Map(current).set(turn.id, turn));
      const interrupts = yield* Ref.make<
        ReadonlyArray<ProviderAdapter.ProviderAdapterV2InterruptInput>
      >([]);
      const ids = backgroundScenarioIds(key);
      const rootTurn = (
        turnStatus: OrchestrationV2ProviderTurn["status"],
        completedAt: DateTime.Utc | null,
      ) => ({
        type: "provider_turn.updated" as const,
        driver,
        providerTurn: {
          id: ids.rootProviderTurnId,
          providerThreadId: ids.providerThreadId,
          nodeId: ids.rootNodeId,
          runAttemptId: ids.attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: turnStatus,
          startedAt: terminalAt,
          completedAt,
        },
      });
      const { observed, finalEvents } = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.make(rootTurn("running", null), rootTurn(status, terminalAt)).pipe(
            Stream.concat(
              failure === "later-stream"
                ? Stream.fail(
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: ProviderSessionId.make(`session:${key}`),
                      cause: "provider process exited",
                    }),
                  )
                : Stream.empty,
            ),
          ),
        ingestNormalized: ({ event }) =>
          event.type !== "provider_turn.updated"
            ? Effect.succeed([])
            : failure === "terminal-ingest" && event.providerTurn.status !== "running"
              ? Effect.fail(
                  new ProviderEventIngestor.ProviderEventPublishError({
                    providerSessionId: ProviderSessionId.make(`session:${key}`),
                    eventCount: 1,
                    cause: new Error("SQLITE_FULL: database or disk is full"),
                  }),
                )
              : persist(event.providerTurn).pipe(Effect.as([])),
        interruptTurn: (input) =>
          Ref.update(interrupts, (current) => [...current, input]).pipe(
            Effect.andThen(
              interrupt === "fails"
                ? Effect.fail(
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: input.providerThread.id,
                      providerTurnId: input.providerTurnId,
                      cause: "provider already exited",
                    }),
                  )
                : Effect.void,
            ),
          ),
        beforeTerminalWrite: (request) =>
          Effect.forEach(request.events, (event) =>
            event.type === "provider-turn.updated" ? persist(event.payload) : Effect.void,
          ).pipe(Effect.as(true)),
      });
      const calls = yield* Ref.get(interrupts);
      assert.equal(calls.length, 1);
      assert.isTrue(calls[0]?.requestRuntimeRestart);
      assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
      assert.isTrue(finalEvents.some((event) => event.type === "run.updated"));
      const durable = (yield* Ref.get(durableTurns)).get(ids.rootProviderTurnId);
      // A failed interrupt keeps the stored turn running for the next start to retry.
      assert.equal(durable?.status, interrupt === "fails" ? "running" : status);
      assert.deepEqual(durable?.completedAt, interrupt === "fails" ? null : terminalAt);
    }),
);

it.effect("does not interrupt an ended provider when its terminal write fails", () =>
  Effect.gen(function* () {
    const interrupts = yield* Ref.make(0);
    const writes = yield* Ref.make(0);
    const { observed } = yield* captureRootRunTermination({
      key: "terminal-write-failure",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      interruptTurn: () => Ref.update(interrupts, (count) => count + 1),
      beforeTerminalWrite: () =>
        Effect.gen(function* () {
          if ((yield* Ref.updateAndGet(writes, (count) => count + 1)) === 1) {
            return yield* new EventSink.EventSinkWriteError({ eventCount: 1 });
          }
          return true;
        }),
    });
    assert.equal(yield* Ref.get(interrupts), 0);
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect("does not interrupt a provider when ingestion fails before the root turn is known", () =>
  Effect.gen(function* () {
    const interrupts = yield* Ref.make(0);
    const { observed } = yield* captureRootRunTermination({
      key: "unknown-turn-stream-error",
      initialProviderTurnId: null,
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:unknown-turn"),
            cause: "provider process exited",
          }),
        ),
      interruptTurn: () => Ref.update(interrupts, (count) => count + 1),
    });
    assert.equal(yield* Ref.get(interrupts), 0);
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
  }),
);

it.effect.each(["completed", "failed"] as const)(
  "reports the thread executing until its %s run's event consumer ends",
  (outcome) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const { previewActivityEnded } = yield* captureRootRunTermination({
        key: `preview-activity:${outcome}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) =>
          Stream.fromEffect(Deferred.await(gate)).pipe(
            Stream.flatMap(() =>
              outcome === "completed"
                ? Stream.make(rootTerminalEvent(ids, "completed"))
                : Stream.fail(
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: ProviderSessionId.make("session:exited"),
                      cause: "provider process exited",
                    }),
                  ),
            ),
          ),
        afterStart: () =>
          Effect.gen(function* () {
            const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
            assert.isTrue(
              yield* activity.active(ThreadId.make(`thread:preview-activity:${outcome}`)),
            );
            yield* Deferred.succeed(gate, undefined);
          }),
      });
      assert.isTrue(previewActivityEnded);
    }),
);

it.effect.each([
  { name: "ends once the root turn finishes beside background work", openSubagent: false },
  { name: "stays while a run-owned subagent continues", openSubagent: true },
])("preview activity $name", ({ openSubagent }) =>
  Effect.gen(function* () {
    const key = `preview-activity:background:${openSubagent}`;
    const consumerWaiting = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const providerInstanceId = ProviderInstanceId.make("codex");
    yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
      events: (ids) =>
        Stream.concat(
          Stream.fromIterable([
            ...(openSubagent
              ? [
                  {
                    type: "subagent.updated",
                    driver,
                    subagent: makeRunOwnedSubagentFixture({
                      ids,
                      providerInstanceId,
                      childThreadId: ids.childThreadId,
                      driver,
                      status: "running",
                    }),
                  } as const,
                ]
              : []),
            rootTerminalEvent(ids, "completed"),
          ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
          Stream.fromEffect(
            Deferred.succeed(consumerWaiting, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          ).pipe(Stream.drain),
        ),
      afterStart: (closed) =>
        Effect.gen(function* () {
          yield* Deferred.await(consumerWaiting);
          assert.isFalse(yield* Deferred.isDone(closed));
          const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
          assert.equal(yield* activity.active(ThreadId.make(`thread:${key}`)), openSubagent);
          yield* Deferred.succeed(release, undefined);
        }),
    });
  }),
);

it.effect("fails the run when its event stream ends without a root terminal", () =>
  Effect.gen(function* () {
    const { observed, finalEvents } = yield* captureRootRunTermination({
      key: "stream-end-without-terminal",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () => Stream.empty,
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.equal(
      finalEvents.find((event) => event.type === "provider-thread.updated")?.payload.status,
      "idle",
    );
  }),
);

it.effect("leaves the run to restart recovery when shutdown interrupts its event stream", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stream-end:shutdown",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () => Stream.failCause(Cause.interrupt()),
    });
    assert.deepEqual(written, []);
    assert.deepEqual(observed, []);
  }),
);

it.effect("does not start a turn whose run settled during the app context read", () =>
  Effect.gen(function* () {
    const contextReadStarted = yield* Deferred.make<void>();
    const runFailed = yield* Deferred.make<void>();
    const current = yield* Ref.make(true);
    const providerCalls = yield* Ref.make(0);
    const { observed } = yield* captureRootRunTermination({
      key: "stream-end:context-read",
      shouldStartProviderTurn: () => Ref.get(current),
      shouldFinalizeRun: () => Ref.get(current),
      events: () => Stream.unwrap(Deferred.await(contextReadStarted).pipe(Effect.as(Stream.empty))),
      appContext: Deferred.succeed(contextReadStarted, undefined).pipe(
        Effect.andThen(Deferred.await(runFailed)),
        Effect.as([]),
      ),
      refreshAfterTurn: Ref.set(current, false).pipe(
        Effect.andThen(Deferred.succeed(runFailed, undefined)),
      ),
      startTurn: () => Ref.update(providerCalls, (count) => count + 1),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.equal(yield* Ref.get(providerCalls), 0);
  }),
);

it.effect("keeps completed runs completed when pull request refresh fails", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:refresh-failure",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      refreshAfterTurn: Effect.die("refresh failed"),
    });
    assert.deepEqual(observed, ["run:waiting", "pull-requests-refreshed"]);
  }),
);

it.effect("keeps a failed root's still-running native children live while the run settles", () =>
  Effect.gen(function* () {
    const finalized = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const childTurn = (
      ids: BackgroundScenarioIds,
      status: "running" | "completed",
    ): ProviderAdapter.ProviderAdapterV2Event =>
      ({
        type: "provider_turn.updated",
        driver,
        threadId: ids.childThreadId,
        providerTurn: {
          id: ProviderTurnId.make(`${ids.rootProviderTurnId}:child`),
          providerThreadId: ProviderThreadId.make(`${ids.providerThreadId}:child`),
          nodeId: NodeId.make(`${ids.subagentNodeId}:child-root`),
          runAttemptId: null,
          status,
        },
      }) as ProviderAdapter.ProviderAdapterV2Event;
    const observed = yield* runBackgroundItemScenario(
      "failed-root-live-child",
      (ids) => [
        childThreadCreatedEvent(ids),
        subagentEvent(ids, "running"),
        childTurn(ids, "running"),
        { ...rootTerminalEvent(ids, "failed"), childTurnsContinue: true },
        subagentEvent(ids, "completed"),
        childTurn(ids, "completed"),
      ],
      {
        keepEventStreamOpen: true,
        onFinalized: (events) => Ref.set(finalized, events),
      },
    );

    assert.deepEqual(observed, ["subagent:running", "root-finalized", "subagent:completed"]);
    const written = yield* Ref.get(finalized);
    assert.deepEqual(
      written.flatMap((event) => (event.type === "run.updated" ? [event.payload.status] : [])),
      ["failed"],
    );
    assert.isFalse(
      written.some((event) => event.type === "subagent.updated"),
      "a child that outlives the failed root must not be settled with it",
    );
  }),
);
