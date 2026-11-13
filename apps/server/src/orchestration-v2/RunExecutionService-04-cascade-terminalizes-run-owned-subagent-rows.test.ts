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

it.effect(
  "cascade-terminalizes run-owned subagent rows on interrupt before root finalization",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-interrupt-cascade");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-interrupt-cascade:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            PreviewAgentActivity.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Ref.update(ingested, (current) => [...current, input.event]).pipe(Effect.as([])),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const memberThreadId = ThreadId.make("thread:subagent-interrupt-cascade:member");
      const runningMember = {
        ...runningSubagent,
        id: NodeId.make("node:subagent-interrupt-cascade:member"),
        threadId: childThreadId,
        runId: null,
        parentNodeId: runningChildNode.id,
        childThreadId: memberThreadId,
      };
      const foreignSubagent = {
        ...runningMember,
        id: NodeId.make("node:subagent-interrupt-cascade:foreign-subagent"),
        runId: RunId.make("run:subagent-interrupt-cascade:foreign"),
        childThreadId: unrelatedChildThreadId,
      };
      const runningMemberRoot = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:member-root"),
        threadId: memberThreadId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:member-root"),
      };
      const foreignChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:foreign-child"),
        runId: foreignSubagent.runId,
      };
      const runningChildTurnItem = makeLinkedChildTurnItemFixture({
        ids,
        driver,
        type: "command_execution",
      });
      const foreignChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:foreign-child"),
        runId: foreignSubagent.runId,
      };
      const suppressedChildAssistantTurnItem = makeLinkedChildTurnItemFixture({
        ids: {
          ...ids,
          childItemId: TurnItemId.make("turn-item:subagent-interrupt-cascade:suppressed-assistant"),
        },
        driver,
        type: "assistant_message",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
      };
      const unrelatedChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        nodeId: unrelatedChildNode.id,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-interrupt-cascade"),
          appThread: rootAppThread(ids.threadId),
          providerSessionId: ProviderSessionId.make("session:subagent-interrupt-cascade"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningChildTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: suppressedChildAssistantTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: unrelatedChildTurnItem,
                },
                { type: "subagent.updated", driver, subagent: runningMember },
                { type: "subagent.updated", driver, subagent: foreignSubagent },
                { type: "node.updated", driver, node: runningMemberRoot },
                { type: "node.updated", driver, node: foreignChildNode },
                { type: "turn_item.updated", driver, turnItem: foreignChildTurnItem },
                rootTerminalEvent(ids, "interrupted"),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningSubagent.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningTurnItem.updatedAt,
                    updatedAt: runningTurnItem.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningChildTurnItem,
                    status: "completed" as const,
                    completedAt: runningChildTurnItem.updatedAt,
                    updatedAt: runningChildTurnItem.updatedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningChildNode,
                    status: "completed" as const,
                    completedAt: runningChildNode.startedAt,
                  },
                },
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-interrupt-cascade"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId, memberThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-interrupt-cascade:user"),
            text: "Spawn a subagent then stop.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const subagentEvents = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event] : [],
      );
      const turnItemEvents = events.flatMap((event) => {
        if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") {
          return [];
        }
        return [
          {
            ...event,
            payload: event.payload,
          },
        ];
      });
      const nodeEvents = events.flatMap((event) =>
        event.type === "node.updated" &&
        event.payload.status === "interrupted" &&
        (event.payload.id === runningNode.id || event.payload.id === runningChildNode.id)
          ? [event]
          : [],
      );
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      assert.lengthOf(subagentEvents, 2);
      const terminalSubagent = subagentEvents.find(
        (event) => event.payload.id === runningSubagent.id,
      );
      const terminalMember = subagentEvents.find((event) => event.payload.id === runningMember.id);
      assert.isDefined(terminalMember);
      assert.equal(terminalMember.payload.status, "interrupted");
      assert.equal(terminalMember.payload.runId, null);
      assert.equal(terminalMember.payload.childThreadId, memberThreadId);
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === runningMemberRoot.id &&
            event.payload.status === "interrupted",
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === foreignSubagent.id,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === foreignChildNode.id,
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" && event.payload.id === foreignChildTurnItem.id,
        ),
      );
      assert.isDefined(terminalSubagent);
      assert.equal(terminalSubagent.payload.status, "interrupted");
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.result, null);
      assert.isNotNull(terminalSubagent.payload.completedAt);

      assert.lengthOf(turnItemEvents, 1);
      const terminalTurnItem = turnItemEvents[0];
      assert.isDefined(terminalTurnItem);
      assert.equal(terminalTurnItem.payload.status, "interrupted");
      assert.equal(terminalTurnItem.payload.childThreadId, childThreadId);
      assert.equal(terminalTurnItem.payload.result, null);

      const terminalChildTurnItems = events.flatMap((event) =>
        event.type === "turn-item.updated" &&
        event.payload.id === runningChildTurnItem.id &&
        event.payload.status === "interrupted"
          ? [event]
          : [],
      );
      assert.lengthOf(terminalChildTurnItems, 1);
      const terminalChildTurnItem = terminalChildTurnItems[0];
      assert.isDefined(terminalChildTurnItem);
      assert.equal(terminalChildTurnItem.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.runId, null);
      assert.equal(terminalChildTurnItem.payload.type, "command_execution");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === unrelatedChildTurnItem.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child turn items must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === suppressedChildAssistantTurnItem.id,
        ),
        "suppressed streaming child items must not be created by the cascade",
      );

      assert.lengthOf(nodeEvents, 2);
      assert.isTrue(
        nodeEvents.some(
          (event) => event.payload.id === runningNode.id && event.payload.kind === "subagent",
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "owned child threads without a live run-owned subagent link must not cascade",
      );
      assert.isTrue(
        nodeEvents.some(
          (event) =>
            event.payload.id === runningChildNode.id &&
            event.runId === (runningChildNode.runId ?? ids.runId) &&
            event.payload.threadId === childThreadId &&
            event.payload.kind === "root_turn",
        ),
      );

      const cascadeIndexes = events.flatMap((event, index) => {
        if (event.type === "subagent.updated" && event.payload.status === "interrupted") {
          return [index];
        }
        if (
          event.type === "turn-item.updated" &&
          event.payload.status === "interrupted" &&
          (event.payload.type === "subagent" || event.payload.id === runningChildTurnItem.id)
        ) {
          return [index];
        }
        if (event.type === "node.updated" && event.payload.status === "interrupted") {
          return event.payload.id === runningNode.id || event.payload.id === runningChildNode.id
            ? [index]
            : [];
        }
        return [];
      });
      assert.isTrue(
        cascadeIndexes.every((index) => index < runUpdatedIndex),
        "subagent cascade must precede run.updated",
      );
      assert.isFalse(
        events.some((event) => {
          if (event.type === "subagent.updated") {
            return event.payload.status === "completed";
          }
          if (event.type === "turn-item.updated" && event.payload.type === "subagent") {
            return event.payload.status === "completed";
          }
          return false;
        }),
        "late provider completion must not reopen cascaded subagent rows",
      );
      assert.isFalse(
        (yield* Ref.get(ingested)).some(
          (event) =>
            (event.type === "subagent.updated" && event.subagent.status === "completed") ||
            (event.type === "turn_item.updated" && event.turnItem.status === "completed") ||
            (event.type === "node.updated" && event.node.status === "completed"),
        ),
        "late provider completion must not be ingested after interrupt",
      );
    }),
);

it.effect("omits interrupt results and subagent cascade for a superseded attempt", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      seedOpenSubagent: true,
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
    assert.deepEqual(observed, []);
  }),
);

it.effect("emits run_interrupt_result when superseded attempt still has a hard-stop request", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stop-then-steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["pull-requests-refreshed"]);
    const ids = backgroundScenarioIds("stop-then-steer-supersede");
    const expectedRequestId = yield* Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      return idAllocator.derive.runSignalTurnItem({
        runId: ids.runId,
        signal: "interrupt-request",
      });
    }).pipe(Effect.provide(IdAllocator.layer));
    assert.equal(written[0]?.parentItemId, expectedRequestId);
  }),
);

it.effect("does not overwrite Stop when ownership changes after the finalization read", () =>
  Effect.gen(function* () {
    const { written, observed, submittedEffects, committedEffects } =
      yield* captureRootRunTermination({
        key: "stop-wins-finalization-gap",
        shouldFinalizeRun: () => Effect.succeed(true),
        rejectTerminalWrite: true,
      });
    assert.deepEqual(written, []);
    assert.deepEqual(observed, []);
    assert.deepEqual(
      submittedEffects.map((effect) => effect.request.type),
      ["checkpoint.capture"],
    );
    assert.deepEqual(committedEffects, []);
  }),
);

it.effect.each([
  { providerReason: undefined, requestReason: undefined, expected: "Stopped by the provider" },
  {
    providerReason: "preCompact hook (project): Save a checkpoint.",
    requestReason: undefined,
    expected: "preCompact hook (project): Save a checkpoint.",
  },
  {
    providerReason: "preCompact hook (project): Save a checkpoint.",
    requestReason: "Stopped by the user",
    expected: "Stopped by the user",
  },
])(
  "emits run_interrupt_result with $expected when finalizing the active attempt",
  ({ providerReason, requestReason, expected }) =>
    Effect.gen(function* () {
      const { written, observed, committedEffects } = yield* captureRootRunTermination({
        key: "hard-stop",
        shouldFinalizeRun: () => Effect.succeed(true),
        loadRunInterruptReason: () => Effect.succeed(requestReason),
        events: (ids) =>
          Stream.make({ ...rootTerminalEvent(ids, "interrupted"), reason: providerReason }),
      });
      assert.deepEqual(
        written.map((item) => item.type),
        ["run_interrupt_result"],
      );
      assert.deepEqual(observed, ["run:interrupted", "pull-requests-refreshed"]);
      assert.equal(
        written[0]?.type === "run_interrupt_result" ? written[0].message : undefined,
        expected,
      );
      assert.deepEqual(
        committedEffects.map((effect) => effect.request.type),
        ["checkpoint.capture"],
      );
    }),
);

it.effect("records a finished run as failed when its ownership check cannot be read", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "finalize-guard-read-failure",
      shouldFinalizeRun: () =>
        Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId: ThreadId.make("thread:finalize-guard-read-failure"),
            cause: "database unavailable",
          }),
        ),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
    });
    assert.include(observed, "run:failed");
  }),
);

it.effect("does not refresh pull requests for auxiliary or stale provider terminals", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:auxiliary",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.fromIterable([
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:child") },
            "completed",
          ),
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:previous") },
            "interrupted",
          ),
          rootTerminalEvent(ids, "cancelled"),
        ]),
    });
    assert.deepEqual(observed, ["run:cancelled", "pull-requests-refreshed"]);
  }),
);

it.effect("refreshes pull requests after a provider stream exits with an error", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:stream-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:exited"),
            cause: "provider process exited",
          }),
        ),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.deepEqual(
      written.map((item) => item.type),
      ["error"],
    );
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider event stream closed unexpectedly");
  }),
);

it.effect("records a provider's input rejection at turn start in the terminal error", () =>
  Effect.gen(function* () {
    const rejection = "goal objective must be at most 4000 characters";
    const { written, observed } = yield* captureRootRunTermination({
      key: "start-failure:input-rejected",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () => Stream.never,
      afterStart: (closed) => Deferred.succeed(closed, undefined),
      startTurn: (turnInput) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterTurnStartError({
            driver,
            threadId: turnInput.threadId,
            providerThreadId: turnInput.providerThread.id,
            runId: turnInput.runId,
            cause: new CodexAppServerRequestError({
              code: -32600,
              errorMessage: rejection,
              method: "thread/goal/set",
            }),
          }),
        ),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", rejection);
  }),
);
