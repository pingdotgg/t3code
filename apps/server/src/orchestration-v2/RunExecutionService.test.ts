import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
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
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";
import {
  canRouteRelatedSubagent,
  cascadeTerminalizeRunOwnedSubagents,
  finalProviderThreadStatus,
  layer as runExecutionServiceLayer,
  makeProviderEventRoutingState,
  type ProviderEventRouteIdentity,
  routeProviderEvent,
  RunExecutionServiceV2,
} from "./RunExecutionService.ts";

const driver = ProviderDriverKind.make("codex");

const RunExecutionTestLayer = runExecutionServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      Layer.mock(EventSinkV2)({}),
      idAllocatorLayer,
      Layer.mock(ProviderEventIngestorV2)({ ingestNormalized: () => Effect.succeed([]) }),
      ServerSettingsService.layerTest(),
    ),
  ),
);

it("keeps recoverable turn failures reusable and reserves error for broken threads", () => {
  assert.equal(finalProviderThreadStatus("reusable"), "idle");
  assert.equal(finalProviderThreadStatus("broken"), "error");
});

it.effect("routes shared-runtime events only to their owning root run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const first: ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:first"),
      runId: RunId.make("run:shared-runtime:first"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:first"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:first"),
    };
    const second: ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:second"),
      runId: RunId.make("run:shared-runtime:second"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:second"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:second"),
    };
    const firstTurnId = ProviderTurnId.make("provider-turn:shared-runtime:first");
    const turnEvent: ProviderAdapterV2Event = {
      type: "provider_turn.updated",
      driver,
      threadId: first.threadId,
      providerTurn: {
        id: firstTurnId,
        providerThreadId: first.providerThreadId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        runAttemptId: first.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    };
    const messageEvent: ProviderAdapterV2Event = {
      type: "message.updated",
      driver,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:shared-runtime:first"),
        threadId: first.threadId,
        runId: first.runId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        role: "assistant",
        text: "first only",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    };
    const terminalEvent: ProviderAdapterV2Event = {
      type: "turn.terminal",
      driver,
      providerThreadId: first.providerThreadId,
      providerTurnId: firstTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    };

    const firstInitial = makeProviderEventRoutingState({
      identity: first,
      providerTurnId: null,
    });
    const secondInitial = makeProviderEventRoutingState({
      identity: second,
      providerTurnId: null,
    });
    const [firstTurnAccepted, firstAfterTurn] = routeProviderEvent(turnEvent, first, firstInitial);
    const [secondTurnAccepted, secondAfterTurn] = routeProviderEvent(
      turnEvent,
      second,
      secondInitial,
    );

    assert.isTrue(firstTurnAccepted);
    assert.isFalse(secondTurnAccepted);
    assert.isTrue(routeProviderEvent(messageEvent, first, firstAfterTurn)[0]);
    assert.isFalse(routeProviderEvent(messageEvent, second, secondAfterTurn)[0]);
    assert.isTrue(routeProviderEvent(terminalEvent, first, firstAfterTurn)[0]);
    assert.isFalse(routeProviderEvent(terminalEvent, second, secondAfterTurn)[0]);
  }),
);

it("does not route a superseded attempt through a reused provider thread", () => {
  const threadId = ThreadId.make("thread:shared-runtime:restart");
  const providerThreadId = ProviderThreadId.make("provider-thread:shared-runtime:restart");
  const oldAttempt: ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:shared-runtime:restart"),
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:old"),
    providerThreadId,
  };
  const newAttempt: ProviderEventRouteIdentity = {
    ...oldAttempt,
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:new"),
  };
  const oldTurnEvent: ProviderAdapterV2Event = {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: ProviderTurnId.make("provider-turn:shared-runtime:restart:old"),
      providerThreadId,
      nodeId: NodeId.make("node:shared-runtime:restart:old"),
      runAttemptId: oldAttempt.attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "interrupted",
      startedAt: null,
      completedAt: null,
    },
  };

  const newState = makeProviderEventRoutingState({ identity: newAttempt, providerTurnId: null });
  assert.isFalse(routeProviderEvent(oldTurnEvent, newAttempt, newState)[0]);
});

it("does not carry interrupted child ownership into later attempts", () => {
  assert.isFalse(canRouteRelatedSubagent("interrupted"));
  assert.isFalse(canRouteRelatedSubagent("failed"));
  assert.isFalse(canRouteRelatedSubagent("cancelled"));
  assert.isTrue(canRouteRelatedSubagent("completed"));
  assert.isTrue(canRouteRelatedSubagent("running"));

  const threadId = ThreadId.make("thread:related-child:next-attempt");
  const childThreadId = ThreadId.make("thread:related-child:interrupted");
  const identity: ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:related-child:next-attempt"),
    attemptId: RunAttemptId.make("attempt:related-child:next-attempt"),
    providerThreadId: ProviderThreadId.make("provider-thread:related-child:next-attempt"),
  };
  const state = makeProviderEventRoutingState({
    identity,
    providerTurnId: null,
    relatedThreadIds: canRouteRelatedSubagent("interrupted") ? [childThreadId] : [],
  });
  const childNodeId = NodeId.make("node:related-child:interrupted");
  const lateChildNode = {
    type: "node.updated",
    driver,
    node: {
      id: childNodeId,
      threadId: childThreadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: childNodeId,
      kind: "root_turn",
      status: "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: null,
    },
  } satisfies ProviderAdapterV2Event;

  assert.isFalse(routeProviderEvent(lateChildNode, identity, state)[0]);
});

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionServiceV2;
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const threadId = ThreadId.make("thread:run-execution-start-guard");
    const runId = RunId.make("run:run-execution-start-guard");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-start-guard");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-start-guard");
    const rootNodeId = NodeId.make("node:run-execution-start-guard");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run;
    const rootNode = { id: rootNodeId } as OrchestrationV2ExecutionNode;
    const providerThread = {
      id: providerThreadId,
      driver,
    } as OrchestrationV2ProviderThread;
    const attempt = {
      id: attemptId,
      providerTurnId: null,
    } as OrchestrationV2RunAttempt;
    const session = {
      events: Stream.never,
      startTurn: () => Ref.update(providerStarts, (count) => count + 1),
    } as unknown as ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-start-guard"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId,
      session,
      run,
      rootNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard"),
      } as OrchestrationV2CheckpointScope,
      providerThread,
      attempt,
      attemptId,
      providerTurnOrdinal: 1,
      shouldStartProviderTurn: () =>
        Ref.modify(guardCalls, (calls) => [calls === 0, calls + 1] as const),
      message: {
        messageId: MessageId.make("message:run-execution-start-guard"),
        text: "Do not start after ownership changes.",
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

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
  }).pipe(Effect.provide(RunExecutionTestLayer)),
);

it.effect("keeps ingesting owned child events after the root turn terminalizes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-late-child");
    const childThreadId = ThreadId.make("thread:run-execution-late-child:child");
    const runId = RunId.make("run:run-execution-late-child");
    const attemptId = RunAttemptId.make("attempt:run-execution-late-child");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-late-child");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-late-child");
    const childProviderThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-late-child:child",
    );
    const rootProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child");
    const childProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child:child");
    const rootNodeId = NodeId.make("node:run-execution-late-child");
    const childNodeId = NodeId.make("node:run-execution-late-child:child");
    const subagentNodeId = NodeId.make("node:run-execution-late-child:subagent");
    const childMessageIngested = yield* Deferred.make<void>();
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const testLayer = runExecutionServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === runId,
                  )
                ) {
                  yield* Ref.update(order, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          idAllocatorLayer,
          Layer.mock(ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                if (
                  input.event.type === "message.updated" &&
                  input.event.message.threadId === childThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "child-message"]);
                  yield* Deferred.succeed(childMessageIngested, undefined).pipe(Effect.ignore);
                }
                return [];
              }),
          }),
          ServerSettingsService.layerTest(),
        ),
      ),
    );
    const events: ReadonlyArray<ProviderAdapterV2Event> = [
      {
        type: "app_thread.created",
        driver,
        appThread: {
          id: childThreadId,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          id: childProviderThreadId,
          appThreadId: childThreadId,
        },
      } as ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "running",
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "running",
        },
      } as ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      },
      {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make("message:run-execution-late-child:child"),
          threadId: childThreadId,
          runId: null,
          nodeId: childNodeId,
          role: "assistant",
          text: "Hello.",
          streaming: false,
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "completed",
        },
      } as ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "completed",
        },
      } as ProviderAdapterV2Event,
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-late-child"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-late-child"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-late-child:user"),
          text: "Spawn a child and finish.",
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
    }).pipe(Effect.provide(testLayer));

    const observed = yield* Deferred.await(childMessageIngested).pipe(
      Effect.timeoutOption("2 seconds"),
    );
    assert.isTrue(Option.isSome(observed), "child message was not ingested after root terminal");
    assert.deepEqual(yield* Ref.get(order), ["root-finalized", "child-message"]);
  }),
);

it.effect("keeps ingesting a late background command item completion after root terminal", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-command", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("ingests the trailing subagent item completion after the subagent row completes", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("subagent-trailing-item", (ids) => [
      subagentEvent(ids, "running"),
      backgroundTurnItemEvent(ids, "subagent", "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "subagent", "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("keeps ingesting a child thread's late background item completion", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-child-item", (ids) => [
      childThreadCreatedEvent(ids),
      subagentEvent(ids, "running"),
      childBackgroundTurnItemEvent(ids, "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      childBackgroundTurnItemEvent(ids, "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("keeps ingesting until the last of several background items terminalizes", () =>
  Effect.gen(function* () {
    const secondItemId = TurnItemId.make("turn-item:bg-multi:second");
    const observed = yield* runBackgroundItemScenario("bg-multi", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      backgroundTurnItemEvent(ids, "dynamic_tool", "running", 2, secondItemId),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 3),
      backgroundTurnItemEvent(ids, "dynamic_tool", "completed", 4, secondItemId),
    ]);
    assert.deepEqual(observed, [
      "turn_item:running",
      "turn_item:running",
      "root-finalized",
      "turn_item:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("does not pin ingestion on background items when the root turn is interrupted", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-interrupted", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "interrupted"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized"]);
  }),
);

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
      const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapterV2Event>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = runExecutionServiceLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
            Layer.mock(EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            idAllocatorLayer,
            Layer.mock(ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Ref.update(ingested, (current) => [...current, input.event]).pipe(Effect.as([])),
            }),
            ServerSettingsService.layerTest(),
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
      const runningChildTurnItem = makeLinkedChildTurnItemFixture({
        ids,
        driver,
        type: "command_execution",
      });
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
        const runExecution = yield* RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-interrupt-cascade"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
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
                rootTerminalEvent(ids, "interrupted"),
                // Late provider completion after interrupt must not be ingested.
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
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
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
          relatedThreadIds: [unrelatedChildThreadId],
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
      }).pipe(Effect.provide(testLayer));

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

      assert.lengthOf(subagentEvents, 1);
      const terminalSubagent = subagentEvents[0];
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

it.effect(
  "cascades linked child-thread nodes after run-owned subagent and turn-item terminalize",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-link-survives-terminal");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-link-survives-terminal:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = runExecutionServiceLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
            Layer.mock(EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            idAllocatorLayer,
            Layer.mock(ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            ServerSettingsService.layerTest(),
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
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
      };
      const completedAt = runningSubagent.updatedAt;

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-link-survives-terminal"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:subagent-link-survives-terminal"),
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
                // Subagent + turn-item settle before root interrupt; linkage
                // must still prove the open child-thread node is cascadeable.
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "subagent finished first",
                    completedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "turn item finished first",
                    completedAt,
                    updatedAt: completedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningNode,
                    status: "completed" as const,
                    completedAt,
                  },
                },
                rootTerminalEvent(ids, "interrupted"),
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-link-survives-terminal"),
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
          relatedThreadIds: [unrelatedChildThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-link-survives-terminal:user"),
            text: "Subagent settles before root interrupt.",
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
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      const cascadedChildNodeEvents = events.flatMap((event, index) =>
        event.type === "node.updated" &&
        event.payload.id === runningChildNode.id &&
        event.payload.status === "interrupted"
          ? [{ event, index }]
          : [],
      );
      assert.lengthOf(
        cascadedChildNodeEvents,
        1,
        "open linked child-thread node must cascade after subagent/turn-item terminalize",
      );
      const cascadedChild = cascadedChildNodeEvents[0];
      assert.isDefined(cascadedChild);
      assert.isTrue(
        cascadedChild.index < runUpdatedIndex,
        "child-thread cascade must precede run.updated",
      );
      assert.equal(cascadedChild.event.payload.threadId, childThreadId);
      assert.equal(cascadedChild.event.payload.kind, "root_turn");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child threads must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.status === "interrupted",
        ),
        "already-terminal subagent rows must not be re-cascaded",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "subagent" &&
            event.payload.status === "interrupted",
        ),
        "already-terminal subagent turn items must not be re-cascaded",
      );
    }),
);

it.effect("cascade helper is provider-neutral for Claude and Codex-shaped child projections", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    let nextId = 0;
    const allocateEventId = () =>
      Effect.sync(() => EventId.make(`event:cascade-helper:${nextId++}`));

    for (const driverKind of [
      ProviderDriverKind.make("claudeAgent"),
      ProviderDriverKind.make("codex"),
    ] as const) {
      const runId = RunId.make(`run:cascade-helper:${driverKind}`);
      const threadId = ThreadId.make(`thread:cascade-helper:${driverKind}`);
      const childThreadId = ThreadId.make(`thread:cascade-helper:${driverKind}:child`);
      const subagentId = NodeId.make(`node:cascade-helper:${driverKind}:subagent`);
      const childNodeId = NodeId.make(`node:cascade-helper:${driverKind}:child-root`);
      const providerInstanceId = ProviderInstanceId.make(String(driverKind));
      const terminalStatus = driverKind === "claudeAgent" ? "failed" : "cancelled";
      const subagent: OrchestrationV2Subagent = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        origin: "provider_native",
        createdBy: "agent",
        driver: driverKind,
        providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: {
          driver: driverKind,
          nativeId: `native-${driverKind}`,
          strength: "strong",
        },
        prompt: "hold",
        title: "hold",
        model: null,
        status: "running",
        progress: "partial progress",
        result: "partial result",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const turnItem = {
        id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}`),
        threadId,
        runId,
        nodeId: subagentId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        parentItemId: null,
        ordinal: 3,
        status: "running" as const,
        title: "hold",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent" as const,
        subagentId,
        origin: "provider_native" as const,
        driver: driverKind,
        providerInstanceId,
        childThreadId,
        prompt: "hold",
        progress: "partial progress",
        result: "partial result",
      } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
      const node: OrchestrationV2ExecutionNode = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        rootNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const openChildNode: OrchestrationV2ExecutionNode = {
        id: childNodeId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: childNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const childTurnItem: OrchestrationV2TurnItem =
        driverKind === "claudeAgent"
          ? {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-reasoning`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "Working",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "reasoning",
              text: "partial progress",
              streaming: true,
            }
          : {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-command`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "sleep 300",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "command_execution",
              input: "sleep 300",
            };

      const events = yield* cascadeTerminalizeRunOwnedSubagents({
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        open: {
          subagents: new Map([[subagentId, subagent]]),
          turnItems: new Map([[subagentId, turnItem]]),
          childTurnItems: new Map(),
          nodes: new Map([[subagentId, node]]),
          linkedChildThreadIds: new Set([childThreadId]),
        },
        status: terminalStatus,
        completedAt: now,
        allocateEventId,
      });

      assert.equal(events.length, 3, `${driverKind}: subagent + node + turn item`);
      const terminalSubagent = events.find((event) => event.type === "subagent.updated");
      assert.isDefined(terminalSubagent);
      if (terminalSubagent?.type !== "subagent.updated") {
        assert.fail("expected subagent.updated event");
        return;
      }
      assert.equal(terminalSubagent.payload.status, terminalStatus);
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.progress, "partial progress");
      assert.equal(terminalSubagent.payload.result, "partial result");
      assert.equal(terminalSubagent.payload.driver, driverKind);

      const terminalItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "subagent",
      );
      assert.isDefined(terminalItem);
      if (terminalItem?.type !== "turn-item.updated" || terminalItem.payload.type !== "subagent") {
        assert.fail("expected subagent turn-item.updated event");
        return;
      }
      assert.equal(terminalItem.payload.status, terminalStatus);
      assert.equal(terminalItem.payload.childThreadId, childThreadId);
      assert.equal(terminalItem.payload.progress, "partial progress");
      assert.equal(terminalItem.payload.result, "partial result");

      // Shared cascade path: after subagent/turn-item rows are gone, only the
      // preserved linkage may prove an open child-thread node is cascadeable.
      const afterTerminalLinkEvents = yield* cascadeTerminalizeRunOwnedSubagents({
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        open: {
          subagents: new Map(),
          turnItems: new Map(),
          childTurnItems: new Map([[childTurnItem.id, childTurnItem]]),
          nodes: new Map([[childNodeId, openChildNode]]),
          linkedChildThreadIds: new Set([childThreadId]),
        },
        status: terminalStatus,
        completedAt: now,
        allocateEventId,
      });
      assert.equal(
        afterTerminalLinkEvents.length,
        2,
        `${driverKind}: linked child node and turn item cascade after link rows terminalize`,
      );
      const cascadedChild = afterTerminalLinkEvents.find((event) => event.type === "node.updated");
      assert.isDefined(cascadedChild);
      if (cascadedChild?.type !== "node.updated") {
        assert.fail("expected node.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChild.payload.id, childNodeId);
      assert.equal(cascadedChild.payload.threadId, childThreadId);
      assert.equal(cascadedChild.payload.status, terminalStatus);
      assert.equal(cascadedChild.payload.kind, "root_turn");
      const cascadedChildTurnItem = afterTerminalLinkEvents.find(
        (event) => event.type === "turn-item.updated",
      );
      assert.isDefined(cascadedChildTurnItem);
      if (cascadedChildTurnItem?.type !== "turn-item.updated") {
        assert.fail("expected turn-item.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChildTurnItem.threadId, childThreadId);
      assert.equal(cascadedChildTurnItem.payload.id, childTurnItem.id);
      assert.equal(cascadedChildTurnItem.payload.status, terminalStatus);
      assert.equal(cascadedChildTurnItem.payload.runId, null);
      assert.equal(cascadedChildTurnItem.payload.type, childTurnItem.type);
      if (cascadedChildTurnItem.payload.type === "reasoning") {
        assert.isFalse(cascadedChildTurnItem.payload.streaming);
      }
    }
  }),
);

it.effect("omits interrupt results and subagent cascade for a superseded attempt", () =>
  Effect.gen(function* () {
    const written = yield* captureInterruptTerminalTurnItems({
      key: "steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      seedOpenSubagent: true,
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
  }),
);

it.effect("emits run_interrupt_result when superseded attempt still has a hard-stop request", () =>
  Effect.gen(function* () {
    const written = yield* captureInterruptTerminalTurnItems({
      key: "stop-then-steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    const ids = backgroundScenarioIds("stop-then-steer-supersede");
    const expectedRequestId = yield* Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      return idAllocator.derive.runSignalTurnItem({
        runId: ids.runId,
        signal: "interrupt-request",
      });
    }).pipe(Effect.provide(idAllocatorLayer));
    assert.equal(written[0]?.parentItemId, expectedRequestId);
  }),
);

it.effect("omits run_interrupt_result when superseded attempt request is already paired", () =>
  Effect.gen(function* () {
    const written = yield* captureInterruptTerminalTurnItems({
      key: "stop-then-steer-already-paired",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(false),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
  }),
);

it.effect("emits run_interrupt_result when hard-stop finalizes the active attempt", () =>
  Effect.gen(function* () {
    const written = yield* captureInterruptTerminalTurnItems({
      key: "hard-stop",
      shouldFinalizeRun: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
  }),
);

function captureInterruptTerminalTurnItems(input: {
  readonly key: string;
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, never>;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly seedOpenSubagent?: boolean;
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const runningSubagent = makeRunOwnedSubagentFixture({
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    });
    const writtenItems = yield* Ref.make<
      ReadonlyArray<{ readonly type: string; readonly parentItemId: string | null }>
    >([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: {
      readonly type: string;
      readonly parentItemId: string | null;
    }) =>
      Ref.update(writtenItems, (current) => [
        ...current,
        { type: payload.type, parentItemId: payload.parentItemId },
      ]);
    const testLayer = runExecutionServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSinkV2)({
            write: (payload) =>
              Effect.gen(function* () {
                for (const event of payload.events) {
                  if (event.type === "turn-item.updated") {
                    yield* captureTurnItem(event.payload);
                  }
                }
                return [];
              }),
            writeWithEffects: (payload) =>
              Effect.gen(function* () {
                for (const event of payload.events) {
                  if (event.type === "turn-item.updated") {
                    yield* captureTurnItem(event.payload);
                  }
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          idAllocatorLayer,
          Layer.mock(ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettingsService.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${input.key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${input.key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events: Stream.fromIterable([
              ...(input.seedOpenSubagent
                ? [
                    { type: "subagent.updated", driver, subagent: runningSubagent } as const,
                    {
                      type: "node.updated",
                      driver,
                      node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
                    } as const,
                    {
                      type: "turn_item.updated",
                      driver,
                      turnItem: makeRunOwnedSubagentTurnItemFixture({
                        ids,
                        providerInstanceId,
                        childThreadId: ids.childThreadId,
                        driver,
                        status: "running",
                      }),
                    } as const,
                  ]
                : []),
              rootTerminalEvent(ids, "interrupted"),
            ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
            close: Deferred.succeed(ingestionDone, undefined),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: {
          id: ids.rootNodeId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
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
        providerTurnOrdinal: 1,
        shouldFinalizeRun: input.shouldFinalizeRun,
        ...(input.hasUnpairedRunInterruptRequest === undefined
          ? {}
          : {
              hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
            }),
        message: {
          messageId: MessageId.make(`message:${input.key}`),
          text: "interrupt projection",
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
    }).pipe(Effect.provide(testLayer));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");
    return yield* Ref.get(writtenItems);
  });
}

interface BackgroundScenarioIds {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly rootProviderTurnId: ProviderTurnId;
  readonly rootNodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly childItemId: TurnItemId;
  readonly subagentNodeId: NodeId;
}

function backgroundScenarioIds(key: string): BackgroundScenarioIds {
  return {
    threadId: ThreadId.make(`thread:${key}`),
    childThreadId: ThreadId.make(`thread:${key}:child`),
    runId: RunId.make(`run:${key}`),
    attemptId: RunAttemptId.make(`attempt:${key}`),
    providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
    rootProviderTurnId: ProviderTurnId.make(`provider-turn:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    itemId: TurnItemId.make(`turn-item:${key}`),
    childItemId: TurnItemId.make(`turn-item:${key}:child`),
    subagentNodeId: NodeId.make(`node:${key}:subagent`),
  };
}

function childThreadCreatedEvent(ids: BackgroundScenarioIds): ProviderAdapterV2Event {
  return {
    type: "app_thread.created",
    driver,
    appThread: {
      id: ids.childThreadId,
      lineage: {
        parentThreadId: ids.threadId,
        relationshipToParent: "subagent",
        rootThreadId: ids.threadId,
      },
    },
  } as ProviderAdapterV2Event;
}

function childBackgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed",
  ordinal: number,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: ids.childItemId,
      threadId: ids.childThreadId,
      runId: null,
      providerTurnId: null,
      ordinal,
      type: "command_execution",
      status,
    },
  } as ProviderAdapterV2Event;
}

function backgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed",
  ordinal: number,
  itemId?: TurnItemId,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId ?? ids.itemId,
      threadId: ids.threadId,
      runId: ids.runId,
      providerTurnId: ids.rootProviderTurnId,
      ordinal,
      type,
      status,
    },
  } as ProviderAdapterV2Event;
}

function subagentEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed",
): ProviderAdapterV2Event {
  return {
    type: "subagent.updated",
    driver,
    subagent: {
      id: ids.subagentNodeId,
      threadId: ids.threadId,
      runId: ids.runId,
      status,
    },
  } as ProviderAdapterV2Event;
}

function makeRunOwnedSubagentFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): OrchestrationV2Subagent {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerThreadId: null,
    childThreadId: input.childThreadId,
    nativeTaskRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    prompt: "hold",
    title: "Live-test subagent hold",
    model: null,
    status: input.status,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

function makeRunOwnedSubagentTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): Extract<OrchestrationV2TurnItem, { type: "subagent" }> {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.itemId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    nodeId: input.ids.subagentNodeId,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 3,
    status: input.status,
    title: "Live-test subagent hold",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: input.ids.subagentNodeId,
    origin: "provider_native",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    childThreadId: input.childThreadId,
    prompt: "hold",
    result: null,
  };
}

function makeLinkedChildTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly driver: typeof driver;
  readonly type: "assistant_message" | "command_execution" | "reasoning";
}): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  const base = {
    id: input.ids.childItemId,
    threadId: input.ids.childThreadId,
    runId: null,
    nodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running" as const,
    title: "Working",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  if (input.type === "assistant_message") {
    return {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make(`${input.ids.childItemId}:message`),
      text: "partial response",
      streaming: true,
    };
  }
  if (input.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: "partial progress",
      streaming: true,
    };
  }
  return {
    ...base,
    type: "command_execution",
    input: "sleep 300",
  };
}

function makeRunOwnedSubagentNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    rootNodeId: input.ids.rootNodeId,
    kind: "subagent",
    status: input.status,
    countsForRun: false,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function makeRunOwnedSubagentChildNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    threadId: input.ids.childThreadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    kind: "root_turn",
    status: input.status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function rootTerminalEvent(
  ids: BackgroundScenarioIds,
  status: "completed" | "interrupted",
): ProviderAdapterV2Event {
  return {
    type: "turn.terminal",
    driver,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.rootProviderTurnId,
    runOrdinal: 1,
    status,
    failure: null,
    threadDisposition: "reusable",
  } as ProviderAdapterV2Event;
}

function runBackgroundItemScenario(
  key: string,
  makeEvents: (ids: BackgroundScenarioIds) => ReadonlyArray<ProviderAdapterV2Event>,
) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const testLayer = runExecutionServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          idAllocatorLayer,
          Layer.mock(ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const event = input.event;
                if (event.type === "turn_item.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `turn_item:${event.turnItem.status}`,
                  ]);
                }
                if (event.type === "subagent.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `subagent:${event.subagent.status}`,
                  ]);
                }
                return [];
              }),
          }),
          ServerSettingsService.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events: Stream.fromIterable(makeEvents(ids)),
            close: Deferred.succeed(ingestionDone, undefined),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
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
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Start a background item and finish.",
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
    }).pipe(Effect.provide(testLayer));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");
    return yield* Ref.get(observed);
  });
}
