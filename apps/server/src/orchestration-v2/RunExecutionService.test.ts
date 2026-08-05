import { assert, it, vi } from "@effect/vitest";
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
  type OrchestrationV2SubagentActivation,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  SubagentActivationId,
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

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";
import {
  canReactivateSubagent,
  canRouteRelatedSubagent,
  cascadeTerminalizeRunOwnedSubagents,
  finalProviderThreadStatus,
  isRunOwnedSubagentTurnItem,
  layer as runExecutionServiceLayer,
  makeProviderEventRoutingState,
  type ProviderEventRouteIdentity,
  routeProviderEvent,
  RunExecutionServiceV2,
  selectInheritedBackgroundTurnItems,
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

it.effect("routes a reused subagent's rows to the run that re-activated it", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:reuse");
    const spawnRunId = RunId.make("run:reuse:1");
    const subagentId = NodeId.make("node:reuse:subagent");
    const childThreadId = ThreadId.make("thread:reuse:child");
    // The turn that re-activates an existing subagent, two runs later.
    const laterRun: ProviderEventRouteIdentity = {
      threadId,
      runId: RunId.make("run:reuse:2"),
      attemptId: RunAttemptId.make("attempt:reuse:2"),
      providerThreadId: ProviderThreadId.make("provider-thread:reuse"),
    };

    // A reusable subagent keeps the run id it was spawned under, and its row is
    // keyed on the parent thread — so neither the run test nor the child-thread
    // test can match. Only the identity seeded from the projection can.
    const subagentEvent: ProviderAdapterV2Event = {
      type: "subagent.updated",
      driver,
      subagent: {
        ...makeRunOwnedSubagentFixture({
          ids: {
            threadId,
            runId: spawnRunId,
            rootNodeId: NodeId.make("node:reuse:root"),
            subagentNodeId: subagentId,
          } as BackgroundScenarioIds,
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId,
          driver,
          status: "running",
        }),
        activationCount: 2,
        updatedAt: now,
      },
    };
    const activationEvent: ProviderAdapterV2Event = {
      type: "subagent_activation.updated",
      driver,
      activation: {
        id: SubagentActivationId.make(`${subagentId}:activation:2`),
        threadId,
        subagentId,
        runId: spawnRunId,
        providerTurnId: null,
        ordinal: 2,
        status: "running",
        usage: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    };
    const turnItemEvent = {
      type: "turn_item.updated",
      driver,
      turnItem: {
        id: TurnItemId.make("turn-item:reuse:subagent"),
        threadId,
        runId: spawnRunId,
        nodeId: subagentId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "running",
        title: "reused agent",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId,
        origin: "provider_native",
        driver,
        providerInstanceId: ProviderInstanceId.make("codex"),
        childThreadId,
        prompt: "continue",
        result: null,
      },
    } satisfies ProviderAdapterV2Event;

    const withoutSeed = makeProviderEventRoutingState({
      identity: laterRun,
      providerTurnId: null,
    });
    assert.isFalse(routeProviderEvent(subagentEvent, laterRun, withoutSeed)[0]);
    assert.isFalse(routeProviderEvent(activationEvent, laterRun, withoutSeed)[0]);
    assert.isFalse(routeProviderEvent(turnItemEvent, laterRun, withoutSeed)[0]);

    const seeded = makeProviderEventRoutingState({
      identity: laterRun,
      providerTurnId: null,
      reactivatableSubagentSeeds: [{ id: subagentId, activationCount: 1 }],
    });

    // Trailing traffic from the run that spawned the agent re-emits at the
    // seeded baseline; identity alone must not admit it, or its stale child
    // thread would be adopted into this run.
    const staleTrailingRow: ProviderAdapterV2Event = {
      ...subagentEvent,
      subagent: { ...subagentEvent.subagent, activationCount: 1 },
    };
    assert.isFalse(routeProviderEvent(staleTrailingRow, laterRun, seeded)[0]);
    const staleActivation: ProviderAdapterV2Event = {
      ...activationEvent,
      activation: {
        ...activationEvent.activation,
        id: SubagentActivationId.make(`${subagentId}:activation:1`),
        ordinal: 1,
      },
    };
    assert.isFalse(routeProviderEvent(staleActivation, laterRun, seeded)[0]);
    // A stale subagent item is refused too until the reactivation is proven.
    assert.isFalse(routeProviderEvent(turnItemEvent, laterRun, seeded)[0]);
    assert.isFalse(
      isRunOwnedSubagentTurnItem({
        turnItem: turnItemEvent.turnItem,
        runId: laterRun.runId,
        activatedSubagentIds: seeded.activatedSubagentIds,
      }),
    );
    const [subagentAccepted, afterSubagent] = routeProviderEvent(subagentEvent, laterRun, seeded);
    assert.isTrue(subagentAccepted);
    assert.isTrue(routeProviderEvent(activationEvent, laterRun, afterSubagent)[0]);
    assert.isTrue(routeProviderEvent(turnItemEvent, laterRun, afterSubagent)[0]);
    assert.isTrue(
      isRunOwnedSubagentTurnItem({
        turnItem: turnItemEvent.turnItem,
        runId: laterRun.runId,
        activatedSubagentIds: afterSubagent.activatedSubagentIds,
      }),
    );
    // Accepting the row also adopts its child thread, so the agent's own
    // messages and turn items route into this run for the rest of it.
    assert.isTrue(afterSubagent.ownedThreadIds.has(childThreadId));
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

it("routes only exact same-thread background items inherited from settled runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-routing");
  const otherThreadId = ThreadId.make("thread:inherited-background-routing:other");
  const priorRunId = RunId.make("run:inherited-background-routing:prior");
  const currentRunId = RunId.make("run:inherited-background-routing:current");
  const itemId = TurnItemId.make("turn-item:inherited-background-routing");
  const identity: ProviderEventRouteIdentity = {
    threadId,
    runId: currentRunId,
    attemptId: RunAttemptId.make("attempt:inherited-background-routing:current"),
    providerThreadId: ProviderThreadId.make("provider-thread:inherited-background-routing:current"),
  };
  const initial = makeProviderEventRoutingState({
    identity,
    inheritedBackgroundTurnItems: [{ id: itemId, runId: priorRunId }],
    providerTurnId: null,
  });
  const inheritedRunning = {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId,
      threadId,
      runId: priorRunId,
      providerTurnId: null,
      ordinal: 1,
      type: "subagent",
      status: "running",
    },
  } as Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
  const unrelatedRunItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      runId: RunId.make("run:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapterV2Event;
  const unlistedPriorItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      id: TurnItemId.make("turn-item:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapterV2Event;
  const unrelatedThreadItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, threadId: otherThreadId },
  } as ProviderAdapterV2Event;
  const ordinaryItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, type: "reasoning" as const },
  } as ProviderAdapterV2Event;
  const inheritedTerminal = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, status: "completed" as const },
  } as ProviderAdapterV2Event;

  const [runningAccepted, afterRunning] = routeProviderEvent(inheritedRunning, identity, initial);
  assert.isTrue(runningAccepted);
  assert.isFalse(routeProviderEvent(unrelatedRunItem, identity, afterRunning)[0]);
  assert.isFalse(routeProviderEvent(unlistedPriorItem, identity, afterRunning)[0]);
  assert.isFalse(routeProviderEvent(unrelatedThreadItem, identity, afterRunning)[0]);
  assert.isFalse(routeProviderEvent(ordinaryItem, identity, afterRunning)[0]);

  const [terminalAccepted, afterTerminal] = routeProviderEvent(
    inheritedTerminal,
    identity,
    afterRunning,
  );
  assert.isTrue(terminalAccepted);
  assert.isFalse(
    routeProviderEvent(inheritedRunning, identity, afterTerminal)[0],
    "a nonterminal replay must not resurrect an inherited terminal",
  );
});

it("selects only live background items from non-completed settled prior runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-selection");
  const otherThreadId = ThreadId.make("thread:inherited-background-selection:other");
  const currentProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:current",
  );
  const foreignProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:foreign-session",
  );
  const interruptedRunId = RunId.make("run:inherited-background-selection:interrupted");
  const failedRunId = RunId.make("run:inherited-background-selection:failed");
  const cancelledRunId = RunId.make("run:inherited-background-selection:cancelled");
  const completedRunId = RunId.make("run:inherited-background-selection:completed");
  const rolledBackRunId = RunId.make("run:inherited-background-selection:rolled-back");
  const currentRunId = RunId.make("run:inherited-background-selection:current");
  const inheritedItemId = TurnItemId.make("turn-item:inherited-background-selection:live");
  const failedItemId = TurnItemId.make("turn-item:inherited-background-selection:failed");
  const cancelledItemId = TurnItemId.make("turn-item:inherited-background-selection:cancelled");
  const makeRun = (
    id: RunId,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    runThreadId = threadId,
  ) =>
    ({
      id,
      threadId: runThreadId,
      ordinal,
      status,
    }) as OrchestrationV2Run;
  const makeItem = (
    id: TurnItemId,
    runId: RunId,
    status: OrchestrationV2TurnItem["status"],
    type: OrchestrationV2TurnItem["type"] = "subagent",
    itemThreadId = threadId,
    providerThreadId = currentProviderThreadId,
  ) =>
    ({
      id,
      threadId: itemThreadId,
      runId,
      providerThreadId,
      type,
      status,
    }) as OrchestrationV2TurnItem;

  const selected = selectInheritedBackgroundTurnItems({
    threadId,
    currentProviderThreadId,
    currentRunOrdinal: 6,
    runs: [
      makeRun(interruptedRunId, 1, "interrupted"),
      makeRun(failedRunId, 2, "failed"),
      makeRun(cancelledRunId, 3, "cancelled"),
      makeRun(completedRunId, 4, "completed"),
      makeRun(rolledBackRunId, 5, "rolled_back"),
      makeRun(currentRunId, 6, "running"),
      makeRun(
        RunId.make("run:inherited-background-selection:other"),
        1,
        "interrupted",
        otherThreadId,
      ),
    ],
    turnItems: [
      makeItem(inheritedItemId, interruptedRunId, "running"),
      makeItem(failedItemId, failedRunId, "running"),
      makeItem(cancelledItemId, cancelledRunId, "running"),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:completed-run"),
        completedRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:terminal"),
        interruptedRunId,
        "completed",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:ordinary"),
        interruptedRunId,
        "running",
        "reasoning",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:rolled-back"),
        rolledBackRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:other-thread"),
        interruptedRunId,
        "running",
        "subagent",
        otherThreadId,
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:foreign-provider"),
        interruptedRunId,
        "running",
        "subagent",
        threadId,
        foreignProviderThreadId,
      ),
    ],
  });

  assert.deepEqual(selected, [
    { id: inheritedItemId, runId: interruptedRunId },
    { id: failedItemId, runId: failedRunId },
    { id: cancelledItemId, runId: cancelledRunId },
  ]);
});

it("does not carry interrupted child ownership into later attempts", () => {
  assert.isFalse(canRouteRelatedSubagent("interrupted"));
  assert.isFalse(canRouteRelatedSubagent("failed"));
  assert.isFalse(canRouteRelatedSubagent("cancelled"));
  assert.isTrue(canRouteRelatedSubagent("completed"));
  assert.isTrue(canRouteRelatedSubagent("running"));

  // Re-activation is deliberately broader: the user stopped an interrupted
  // agent, they did not lose it, and its provider thread is still resumable.
  assert.isTrue(canReactivateSubagent("interrupted"));
  assert.isTrue(canReactivateSubagent("idle"));
  assert.isFalse(canReactivateSubagent("failed"));
  assert.isFalse(canReactivateSubagent("cancelled"));

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

it.effect("re-activates an interrupted subagent without adopting its stale child traffic", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:interrupted-reuse");
    const subagentId = NodeId.make("node:interrupted-reuse:subagent");
    const childThreadId = ThreadId.make("thread:interrupted-reuse:child");
    const laterRun: ProviderEventRouteIdentity = {
      threadId,
      runId: RunId.make("run:interrupted-reuse:2"),
      attemptId: RunAttemptId.make("attempt:interrupted-reuse:2"),
      providerThreadId: ProviderThreadId.make("provider-thread:interrupted-reuse"),
    };

    // What ProviderTurnStartService builds for a previously interrupted agent:
    // its identity is re-activatable, but its child thread is NOT pre-owned.
    const state = makeProviderEventRoutingState({
      identity: laterRun,
      providerTurnId: null,
      relatedThreadIds: [],
      reactivatableSubagentSeeds: [{ id: subagentId, activationCount: 1 }],
    });

    // A late event from the interrupted child thread must still be refused —
    // this is the invariant the post-interrupt recovery fix depends on.
    const lateChildNode: ProviderAdapterV2Event = {
      type: "node.updated",
      driver,
      node: {
        id: NodeId.make("node:interrupted-reuse:late"),
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: NodeId.make("node:interrupted-reuse:late"),
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
    };
    assert.isFalse(routeProviderEvent(lateChildNode, laterRun, state)[0]);

    // A genuine re-activation of that identity is admitted, and only then is
    // the child thread adopted — ownership is earned, not granted up front.
    const reactivation: ProviderAdapterV2Event = {
      type: "subagent.updated",
      driver,
      subagent: {
        ...makeRunOwnedSubagentFixture({
          ids: {
            threadId,
            runId: RunId.make("run:interrupted-reuse:1"),
            rootNodeId: NodeId.make("node:interrupted-reuse:root"),
            subagentNodeId: subagentId,
          } as BackgroundScenarioIds,
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId,
          driver,
          status: "running",
        }),
        activationCount: 4,
        updatedAt: now,
      },
    };
    const [accepted, afterReactivation] = routeProviderEvent(reactivation, laterRun, state);
    assert.isTrue(accepted);
    assert.isTrue(afterReactivation.ownedThreadIds.has(childThreadId));
    assert.isTrue(routeProviderEvent(lateChildNode, laterRun, afterReactivation)[0]);
  }),
);

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

it.effect("refreshes MCP credential liveness before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionServiceV2;
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const threadId = ThreadId.make("thread:run-execution-mcp-liveness");
    const touchActiveMcpThread = vi
      .spyOn(McpSessionRegistry, "touchActiveMcpThread")
      .mockImplementation((touchedThreadId) =>
        Ref.update(order, (entries) => [...entries, `touch:${touchedThreadId}`]),
      );

    yield* runExecution
      .startRootRun({
        commandId: CommandId.make("command:run-execution-mcp-liveness"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make("session:run-execution-mcp-liveness"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(order, (entries) => [...entries, "start-turn"]),
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: RunId.make("run:run-execution-mcp-liveness"),
          threadId,
          ordinal: 1,
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-mcp-liveness"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-mcp-liveness"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-mcp-liveness"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: RunAttemptId.make("attempt:run-execution-mcp-liveness"),
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId: RunAttemptId.make("attempt:run-execution-mcp-liveness"),
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-mcp-liveness"),
          text: "Keep the MCP credential alive.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
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
      })
      .pipe(Effect.ensuring(Effect.sync(() => touchActiveMcpThread.mockRestore())));

    assert.deepEqual(yield* Ref.get(order), [`touch:${threadId}`, "start-turn"]);
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

it.effect("seeds inherited background items before their next update", () =>
  Effect.gen(function* () {
    const key = "inherited-background-seeded";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 1),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["root-finalized", "turn_item:completed"]);
  }),
);

it.effect("releases the live run after an inherited background item terminalizes", () =>
  Effect.gen(function* () {
    const key = "inherited-background-terminal";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "running", 1),
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 2),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("does not hold the live stream open for a foreign provider's background item", () =>
  Effect.gen(function* () {
    const key = "inherited-background-foreign-provider";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const foreignProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:foreign-session`);
    const foreignItem = {
      id: ids.itemId,
      threadId: ids.threadId,
      runId: priorRunId,
      providerThreadId: foreignProviderThreadId,
      type: "subagent",
      status: "running",
    } as OrchestrationV2TurnItem;
    const inherited = selectInheritedBackgroundTurnItems({
      threadId: ids.threadId,
      currentProviderThreadId: ids.providerThreadId,
      currentRunOrdinal: 2,
      runs: [
        {
          id: priorRunId,
          threadId: ids.threadId,
          ordinal: 1,
          status: "interrupted",
        } as OrchestrationV2Run,
      ],
      turnItems: [foreignItem],
    });

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems: () => Effect.succeed(inherited),
      },
    );

    assert.deepEqual(inherited, []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);

it.effect("refreshes inherited background items after event subscription", () =>
  Effect.gen(function* () {
    const key = "inherited-background-subscription-refresh";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const itemStatus = yield* Ref.make<OrchestrationV2TurnItem["status"]>("running");
    const loadInheritedBackgroundTurnItems = () =>
      Ref.get(itemStatus).pipe(
        Effect.map((status) =>
          selectInheritedBackgroundTurnItems({
            threadId: ids.threadId,
            currentProviderThreadId: ids.providerThreadId,
            currentRunOrdinal: 2,
            runs: [
              {
                id: priorRunId,
                threadId: ids.threadId,
                ordinal: 1,
                status: "interrupted",
              } as OrchestrationV2Run,
            ],
            turnItems: [
              {
                id: ids.itemId,
                threadId: ids.threadId,
                runId: priorRunId,
                providerThreadId: ids.providerThreadId,
                type: "subagent",
                status,
              } as OrchestrationV2TurnItem,
            ],
          }),
        ),
      );

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems,
        onSubscribe: Ref.set(itemStatus, "completed"),
      },
    );

    assert.deepEqual(yield* loadInheritedBackgroundTurnItems(), []);
    assert.deepEqual(observed, ["root-finalized"]);
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
          readonly activeAttemptId: RunAttemptId | null;
          readonly eventType: string;
          readonly hasWriteIfRunCurrent: boolean;
          readonly hasWriteIfProviderThreadOwner: boolean;
          readonly expectedLastRunOrdinal: number | null;
          readonly runId: RunId | null;
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
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: true, storedEvents: [] }),
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
                      activeAttemptId: input.writeIfProviderThreadOwner?.activeAttemptId ?? null,
                      eventType: event.type,
                      hasWriteIfRunCurrent: input.writeIfRunCurrent !== undefined,
                      hasWriteIfProviderThreadOwner: input.writeIfProviderThreadOwner !== undefined,
                      expectedLastRunOrdinal:
                        input.writeIfProviderThreadOwner?.expectedLastRunOrdinal ?? null,
                      runId: input.writeIfProviderThreadOwner?.runId ?? null,
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
      assert.isFalse(preTerminalRoster?.hasWriteIfProviderThreadOwner);
      assert.isDefined(lateClear);
      assert.isFalse(
        lateClear?.hasWriteIfRunCurrent,
        "late empty roster must not use stale writeIfRunCurrent running-gate",
      );
      assert.isTrue(
        lateClear?.hasWriteIfProviderThreadOwner,
        "late empty roster must gate on provider-thread ownership",
      );
      assert.equal(lateClear?.expectedLastRunOrdinal, 1);
      assert.equal(lateClear?.runId, ids.runId);
      assert.equal(lateClear?.activeAttemptId, ids.attemptId);
    }),
);

it.effect("drops late root provider-thread writes from a superseded attempt", () =>
  Effect.gen(function* () {
    const key = "bg-roster-attempt-owner-lost";
    const ids = backgroundScenarioIds(key);
    const replacementAttemptId = RunAttemptId.make(`attempt:${key}:replacement`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const now = yield* DateTime.now;
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    // Probe stays true forever so only ownership-loss can release the stream.
    const ingestionDone = yield* Deferred.make<void>();
    const ingestCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly activeAttemptId: RunAttemptId | null;
        readonly eventType: string;
        readonly hasWriteIfProviderThreadOwner: boolean;
        readonly expectedLastRunOrdinal: number | null;
        readonly rosterLength: number | null;
        readonly committed: boolean;
      }>
    >([]);
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
            writeIfProviderThreadOwner: () =>
              Effect.succeed({ committed: false, storedEvents: [] }),
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
                const ownerGate = input.writeIfProviderThreadOwner;
                // Simulate the EventSink reject after a same-run replacement
                // changes activeAttemptId without advancing lastRunOrdinal.
                const rejectAsStaleOwner =
                  ownerGate !== undefined && ownerGate.activeAttemptId !== replacementAttemptId;
                yield* Ref.update(ingestCalls, (current) => [
                  ...current,
                  {
                    activeAttemptId: ownerGate?.activeAttemptId ?? null,
                    eventType: event.type,
                    hasWriteIfProviderThreadOwner: ownerGate !== undefined,
                    expectedLastRunOrdinal: ownerGate?.expectedLastRunOrdinal ?? null,
                    rosterLength,
                    committed: !rejectAsStaleOwner,
                  },
                ]);
                if (event.type === "turn.terminal") {
                  yield* Ref.update(observed, (current) => [...current, "terminal"]);
                }
                if (event.type === "provider_thread.updated" && rejectAsStaleOwner) {
                  yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                  return [];
                }
                if (event.type === "provider_thread.updated") {
                  yield* Ref.update(observed, (current) => [...current, "roster-written"]);
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
          hasPendingBackgroundWork: Effect.succeed(true),
          hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
          subscribeEvents: Effect.succeed({
            events: Stream.fromIterable([
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "active" as const,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", taskType: "local_bash" },
                  ],
                  updatedAt: now,
                },
              } as ProviderAdapterV2Event,
              rootTerminalEvent(ids, "completed"),
              // Late snapshot after a replacement attempt claimed the same
              // run ordinal. Without attempt gating this would clobber it.
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "idle" as const,
                  lastRunOrdinal: 1,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", taskType: "local_bash" },
                  ],
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
          text: "Background work that loses ownership.",
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
    assert.isTrue(
      Option.isSome(closed),
      "subscription must release after ownership-loss reject even when probe stays true",
    );
    assert.deepEqual(yield* Ref.get(observed), [
      "roster-written",
      "terminal",
      "root-finalized",
      "stale-owner-rejected",
    ]);

    const calls = yield* Ref.get(ingestCalls);
    const lateStale = calls.find(
      (call) =>
        call.eventType === "provider_thread.updated" &&
        call.hasWriteIfProviderThreadOwner &&
        call.rosterLength === 1,
    );
    assert.isDefined(lateStale);
    assert.equal(lateStale?.expectedLastRunOrdinal, 1);
    assert.equal(lateStale?.activeAttemptId, ids.attemptId);
    assert.isFalse(lateStale?.committed);
  }),
);

it.effect(
  "keeps ingesting a late background turn-item completion after ownership-loss rejects roster writes",
  () =>
    Effect.gen(function* () {
      const key = "bg-item-after-owner-lost";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      // Probe stays true forever; open background items must pin the stream
      // past ownership-loss so late turn_item completions still land.
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
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: false, storedEvents: [] }),
            }),
            idAllocatorLayer,
            Layer.mock(ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  const event = input.event;
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  if (
                    event.type === "provider_thread.updated" &&
                    input.writeIfProviderThreadOwner !== undefined
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                    return [];
                  }
                  if (event.type === "turn_item.updated") {
                    yield* Ref.update(observed, (current) => [
                      ...current,
                      `turn_item:${event.turnItem.status}`,
                    ]);
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
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                backgroundTurnItemEvent(ids, "command_execution", "running", 1),
                rootTerminalEvent(ids, "completed"),
                // Ownership reject after a newer run claimed lastRunOrdinal.
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    lastRunOrdinal: 1,
                    pendingBackgroundTasks: [
                      { taskId: "bg-stale", description: "sleep 20", taskType: "local_bash" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
                // Late completion still writable (turn_item writes are not
                // ownership-gated); stream must stay open for it.
                backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
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
            text: "Background item after ownership loss.",
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
      assert.isTrue(
        Option.isSome(closed),
        "subscription must release after background item completes past ownership loss",
      );
      assert.deepEqual(yield* Ref.get(observed), [
        "turn_item:running",
        "terminal",
        "root-finalized",
        "stale-owner-rejected",
        "turn_item:completed",
      ]);
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
      const activationId = SubagentActivationId.make(
        `node:cascade-helper:${driverKind}:subagent:activation:2`,
      );
      const previousActivationId = SubagentActivationId.make(
        `node:cascade-helper:${driverKind}:subagent:activation:1`,
      );
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
        kind: "subagent",
        role: { name: "general-purpose", source: "app_default" },
        status: "running",
        progress: "partial progress",
        result: "partial result",
        usage: null,
        currentActivationId: activationId,
        activationCount: 2,
        workflow: null,
        workflowMembership: null,
        recentActivity: [],
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const activation: OrchestrationV2SubagentActivation = {
        id: activationId,
        threadId,
        subagentId,
        runId,
        providerTurnId: null,
        ordinal: 2,
        status: "running",
        usage: { totalTokens: 120, toolUses: 2 },
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const previousActivation: OrchestrationV2SubagentActivation = {
        ...activation,
        id: previousActivationId,
        ordinal: 1,
        usage: { totalTokens: 60, toolUses: 1 },
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
          activations: new Map([
            [previousActivation.id, previousActivation],
            [activation.id, activation],
          ]),
          turnItems: new Map([[subagentId, turnItem]]),
          childTurnItems: new Map(),
          nodes: new Map([[subagentId, node]]),
          linkedChildThreadIds: new Set([childThreadId]),
        },
        status: terminalStatus,
        completedAt: now,
        allocateEventId,
      });

      assert.equal(events.length, 5, `${driverKind}: subagent + activations + node + turn item`);
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
      assert.isNull(terminalSubagent.payload.currentActivationId);

      const terminalActivations = events.filter(
        (
          event,
        ): event is Extract<OrchestrationV2DomainEvent, { type: "subagent-activation.updated" }> =>
          event.type === "subagent-activation.updated",
      );
      assert.deepEqual(
        terminalActivations.map((event) => ({
          id: event.payload.id,
          status: event.payload.status,
          totalTokens: event.payload.usage?.totalTokens,
        })),
        [
          { id: previousActivationId, status: terminalStatus, totalTokens: 60 },
          { id: activationId, status: terminalStatus, totalTokens: 120 },
        ],
      );

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
          activations: new Map(),
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

it.effect("terminalizes an identity-owned reused subagent turn item from its spawning run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const runId = RunId.make("run:reused-turn-item:current");
    const spawnRunId = RunId.make("run:reused-turn-item:spawn");
    const threadId = ThreadId.make("thread:reused-turn-item");
    const subagentId = NodeId.make("node:reused-turn-item:subagent");
    const turnItem = {
      id: TurnItemId.make("turn-item:reused-turn-item:subagent"),
      threadId,
      runId: spawnRunId,
      nodeId: subagentId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running" as const,
      title: "reused agent",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent" as const,
      subagentId,
      origin: "provider_native" as const,
      driver,
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: ThreadId.make("thread:reused-turn-item:child"),
      prompt: "continue",
      progress: "working",
      result: null,
    } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

    const events = yield* cascadeTerminalizeRunOwnedSubagents({
      run: {
        id: runId,
        threadId,
        ordinal: 2,
        providerInstanceId: ProviderInstanceId.make("codex"),
      } as OrchestrationV2Run,
      open: {
        subagents: new Map(),
        activations: new Map(),
        turnItems: new Map([[subagentId, turnItem]]),
        childTurnItems: new Map(),
        nodes: new Map(),
        linkedChildThreadIds: new Set(),
      },
      status: "interrupted",
      completedAt: now,
      allocateEventId: () => Effect.succeed(EventId.make("event:reused-turn-item:cascade")),
    });

    assert.lengthOf(events, 1);
    const event = events[0];
    assert.isDefined(event);
    if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") {
      assert.fail("expected reused subagent turn-item.updated event");
      return;
    }
    assert.equal(event.runId, runId);
    assert.equal(event.payload.runId, spawnRunId);
    assert.equal(event.payload.status, "interrupted");
    assert.equal(event.payload.id, turnItem.id);
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

function backgroundTurnItemEventForRun(
  ids: BackgroundScenarioIds,
  runId: RunId,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed",
  ordinal: number,
): ProviderAdapterV2Event {
  const event = backgroundTurnItemEvent(ids, type, status, ordinal);
  if (event.type !== "turn_item.updated") {
    return event;
  }
  return { ...event, turnItem: { ...event.turnItem, runId } };
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
    kind: "subagent",
    role: { name: "general-purpose", source: "app_default" },
    status: input.status,
    result: null,
    usage: null,
    currentActivationId: null,
    activationCount: 1,
    workflow: null,
    workflowMembership: null,
    recentActivity: [],
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
  options?: {
    readonly keepEventStreamOpen?: boolean;
    readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
      ReadonlyArray<{ readonly id: TurnItemId; readonly runId: RunId }>
    >;
    readonly onSubscribe?: Effect.Effect<void>;
  },
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
          subscribeEvents: Effect.gen(function* () {
            yield* options?.onSubscribe ?? Effect.void;
            const events = Stream.fromIterable(makeEvents(ids));
            return {
              events:
                options?.keepEventStreamOpen === true
                  ? events.pipe(Stream.concat(Stream.never))
                  : events,
              close: Deferred.succeed(ingestionDone, undefined),
            };
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
        ...(options?.loadInheritedBackgroundTurnItems === undefined
          ? {}
          : {
              loadInheritedBackgroundTurnItems: options.loadInheritedBackgroundTurnItems,
            }),
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
