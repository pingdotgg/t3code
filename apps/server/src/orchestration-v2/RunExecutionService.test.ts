import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
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
  "keeps ingesting a late empty provider-thread roster while thread-scoped pending work is true",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-pending-work";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const pendingByProviderThreadId = yield* Ref.make(new Map([[ids.providerThreadId, true]]));
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
      const ingestCalls = yield* Ref.make<
        ReadonlyArray<{
          readonly eventType: string;
          readonly hasWriteIfRunCurrent: boolean;
          readonly rosterLength: number | null;
        }>
      >([]);
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
                  const rosterLength =
                    event.type === "provider_thread.updated"
                      ? (event.providerThread.pendingBackgroundTasks?.length ?? 0)
                      : null;
                  yield* Ref.update(ingestCalls, (current) => [
                    ...current,
                    {
                      eventType: event.type,
                      hasWriteIfRunCurrent: input.writeIfRunCurrent !== undefined,
                      rosterLength,
                    },
                  ]);
                  if (event.type === "provider_thread.updated" && rosterLength === 0) {
                    yield* Ref.update(pendingByProviderThreadId, (current) => {
                      const next = new Map(current);
                      next.set(event.providerThread.id, false);
                      return next;
                    });
                    yield* Ref.update(observed, (current) => [...current, "roster-cleared"]);
                  }
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettingsService.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            // Session-wide stays true forever; the root must consult the
            // thread-scoped probe instead of being pinned by siblings.
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                return (yield* Ref.get(pendingByProviderThreadId)).get(providerThread.id) === true;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "active" as const,
                    pendingBackgroundTasks: [
                      { taskId: "bg-1", description: "sleep 20", taskType: "local_bash" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
                rootTerminalEvent(ids, "completed"),
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    pendingBackgroundTasks: [],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
              ]),
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
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Start background work and settle.",
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
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      assert.deepEqual(yield* Ref.get(observed), ["terminal", "root-finalized", "roster-cleared"]);
      assert.isTrue((yield* Ref.get(scopedProbeArgs)).includes(ids.providerThreadId));

      const calls = yield* Ref.get(ingestCalls);
      const preTerminalRoster = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 1,
      );
      const lateClear = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 0,
      );
      assert.isDefined(preTerminalRoster);
      assert.isTrue(preTerminalRoster?.hasWriteIfRunCurrent);
      assert.isDefined(lateClear);
      assert.isFalse(
        lateClear?.hasWriteIfRunCurrent,
        "late empty roster must not use stale writeIfRunCurrent running-gate",
      );
    }),
);

it.effect(
  "does not pin ingestion on a sibling session-wide pending state when this thread has no roster",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-sibling-not-pin";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
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
                  if (input.event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettingsService.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-self",
          strength: "strong" as const,
        },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const siblingProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:sibling`);

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            // Session-wide stays true (sibling has work). Stop must use only
            // the scoped probe for this root's provider thread.
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                // Own thread has no roster; sibling would report true if probed.
                return providerThread.id !== ids.providerThreadId;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                rootTerminalEvent(ids, "completed"),
                // Sibling thread update after terminal. Own-thread scoped
                // pending is false, so this root must release without waiting
                // for sibling-driven session-wide pending work.
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    id: siblingProviderThreadId,
                    appThreadId: ThreadId.make(`thread:${key}:sibling`),
                    nativeThreadRef: {
                      driver,
                      nativeId: "native-sibling",
                      strength: "strong" as const,
                    },
                    pendingBackgroundTasks: [{ taskId: "sibling-bg", description: "other thread" }],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
              ]),
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
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Settle without local pending work.",
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
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      // Critical: release while session-wide hasPendingBackgroundWork stays true
      // and the scoped probe reports false for this root's provider thread.
      const observedEvents = [...(yield* Ref.get(observed))];
      assert.includeMembers(observedEvents, ["terminal", "root-finalized"]);
      const probedIds = yield* Ref.get(scopedProbeArgs);
      assert.isTrue(probedIds.includes(ids.providerThreadId));
      assert.isFalse(probedIds.includes(siblingProviderThreadId));
    }),
);

it.effect("omits run_interrupt_result when a superseding attempt already owns the run", () =>
  Effect.gen(function* () {
    const written = yield* captureInterruptTerminalTurnItems({
      key: "steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
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
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    const providerInstanceId = ProviderInstanceId.make("codex");
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
            events: Stream.fromIterable([rootTerminalEvent(ids, "interrupted")]),
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
