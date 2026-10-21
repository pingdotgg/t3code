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

import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const driver = ProviderDriverKind.make("codex");

const layerTurnItemPositionsTest = Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
  allocate: () => Effect.succeed(1),
});

const layerRunExecutionTest = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layerEmpty,
      Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      layerTurnItemPositionsTest,
      Layer.mock(EventSink.EventSinkV2)({}),
      IdAllocator.layer,
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
        ingestNormalized: () => Effect.succeed([]),
      }),
      ServerSettings.layerTest(),
    ),
  ),
);

it.effect("routes shared-runtime events only to their owning root run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const first: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:first"),
      runId: RunId.make("run:shared-runtime:first"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:first"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:first"),
    };
    const second: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:second"),
      runId: RunId.make("run:shared-runtime:second"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:second"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:second"),
    };
    const firstTurnId = ProviderTurnId.make("provider-turn:shared-runtime:first");
    const turnEvent: ProviderAdapter.ProviderAdapterV2Event = {
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
    const messageEvent: ProviderAdapter.ProviderAdapterV2Event = {
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
    const terminalEvent: ProviderAdapter.ProviderAdapterV2Event = {
      type: "turn.terminal",
      driver,
      providerThreadId: first.providerThreadId,
      providerTurnId: firstTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    };

    const firstInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: first,
      providerTurnId: null,
    });
    const secondInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: second,
      providerTurnId: null,
    });
    const [firstTurnAccepted, firstAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      first,
      firstInitial,
    );
    const [secondTurnAccepted, secondAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      second,
      secondInitial,
    );

    assert.isTrue(firstTurnAccepted);
    assert.isFalse(secondTurnAccepted);
    assert.isTrue(RunExecutionService.routeProviderEvent(messageEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(messageEvent, second, secondAfterTurn)[0],
    );
    assert.isTrue(RunExecutionService.routeProviderEvent(terminalEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(terminalEvent, second, secondAfterTurn)[0],
    );
  }),
);

it("routes only enrolled workflow members after the root turn ends", () => {
  const threadId = ThreadId.make("thread:late-child");
  const rootProviderTurnId = ProviderTurnId.make("provider-turn:late-child");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:late-child"),
    attemptId: RunAttemptId.make("attempt:late-child"),
    providerThreadId: ProviderThreadId.make("provider-thread:late-child"),
  };
  const childCreated = (
    childThreadId: ThreadId,
    parentThreadId = threadId,
  ): ProviderAdapter.ProviderAdapterV2Event =>
    ({
      type: "app_thread.created",
      driver,
      appThread: {
        id: childThreadId,
        lineage: {
          parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
      },
    }) as ProviderAdapter.ProviderAdapterV2Event;
  const earlyChild = ThreadId.make("thread:late-child:early");
  const lateChild = ThreadId.make("thread:late-child:late");

  const initial = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: rootProviderTurnId,
  });
  const [earlyAccepted, live] = RunExecutionService.routeProviderEvent(
    childCreated(earlyChild),
    identity,
    initial,
  );
  assert.isTrue(earlyAccepted);
  const existingDescendant = ThreadId.make("thread:late-child:existing-descendant");
  const [descendantAccepted, withDescendant] = RunExecutionService.routeProviderEvent(
    childCreated(existingDescendant, earlyChild),
    identity,
    live,
  );
  assert.isTrue(descendantAccepted);
  const [terminalAccepted, ended] = RunExecutionService.routeProviderEvent(
    {
      type: "turn.terminal",
      driver,
      providerThreadId: identity.providerThreadId,
      providerTurnId: rootProviderTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    },
    identity,
    withDescendant,
  );
  assert.isTrue(terminalAccepted);
  assert.isTrue(ended.ownedThreadIds.has(earlyChild));
  const [lateAccepted, afterLate] = RunExecutionService.routeProviderEvent(
    childCreated(lateChild),
    identity,
    ended,
  );
  assert.isFalse(lateAccepted);
  assert.isFalse(afterLate.ownedThreadIds.has(lateChild));

  const memberId = ThreadId.make("thread:late-child:workflow-member");
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childCreated(memberId, earlyChild), identity, ended)[0],
  );
  const coordinator: OrchestrationV2Subagent = {
    id: NodeId.make("node:late-child:workflow"),
    threadId,
    runId: identity.runId,
    parentNodeId: NodeId.make("node:late-child"),
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: earlyChild,
    nativeTaskRef: null,
    prompt: "Review the code",
    title: "Review",
    model: null,
    status: "running",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    workflow: {
      phases: [],
      agents: [{ index: 0, label: "Reviewer", state: "running", childThreadId: memberId }],
    },
  };
  const [foreignAccepted, afterForeign] = RunExecutionService.routeProviderEvent(
    {
      type: "subagent.updated",
      driver,
      subagent: {
        ...coordinator,
        threadId: earlyChild,
        childThreadId: existingDescendant,
        runId: RunId.make("run:late-child:new"),
      },
    },
    identity,
    ended,
  );
  assert.isTrue(foreignAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(
      childCreated(memberId, existingDescendant),
      identity,
      afterForeign,
    )[0],
  );
  const [workflowAccepted, afterWorkflow] = RunExecutionService.routeProviderEvent(
    { type: "subagent.updated", driver, subagent: coordinator },
    identity,
    ended,
  );
  assert.isTrue(workflowAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childCreated(memberId), identity, afterWorkflow)[0],
  );
  const [memberAccepted, afterMember] = RunExecutionService.routeProviderEvent(
    childCreated(memberId, earlyChild),
    identity,
    afterWorkflow,
  );
  assert.isTrue(memberAccepted);
  assert.isTrue(afterMember.ownedThreadIds.has(memberId));
  const [unrelatedAccepted] = RunExecutionService.routeProviderEvent(
    childCreated(ThreadId.make("thread:late-child:unrelated-member"), lateChild),
    identity,
    ended,
  );
  assert.isFalse(unrelatedAccepted);
  const [unrelatedDescendantAccepted, afterUnrelatedDescendant] =
    RunExecutionService.routeProviderEvent(
      childCreated(ThreadId.make("thread:late-child:unrelated-descendant"), earlyChild),
      identity,
      afterWorkflow,
    );
  assert.isFalse(unrelatedDescendantAccepted);
  assert.isFalse(
    afterUnrelatedDescendant.ownedThreadIds.has(
      ThreadId.make("thread:late-child:unrelated-descendant"),
    ),
  );
});

it("moves a child thread to the run that shows its subagent now", () => {
  const threadId = ThreadId.make("thread:handoff");
  const rootProviderTurnId = ProviderTurnId.make("provider-turn:handoff");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:handoff:1"),
    attemptId: RunAttemptId.make("attempt:handoff:1"),
    providerThreadId: ProviderThreadId.make("provider-thread:handoff"),
  };
  const resumedChild = ThreadId.make("thread:handoff:resumed");
  const siblingChild = ThreadId.make("thread:handoff:sibling");
  const providerThreadOf = (childThreadId: ThreadId) =>
    ProviderThreadId.make(`provider-thread:${childThreadId}`);
  const subagent = (childThreadId: ThreadId, runId: RunId): OrchestrationV2Subagent => ({
    id: NodeId.make(`node:${childThreadId}`),
    threadId,
    runId,
    parentNodeId: NodeId.make("node:handoff"),
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: providerThreadOf(childThreadId),
    childThreadId,
    nativeTaskRef: null,
    prompt: "Work",
    title: "Work",
    model: null,
    status: "running",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
  });
  const childMessage = (childThreadId: ThreadId) =>
    ({
      type: "message.updated",
      driver,
      message: {
        id: MessageId.make(`message:${childThreadId}`),
        threadId: childThreadId,
        runId: null,
      },
    }) as ProviderAdapter.ProviderAdapterV2Event;
  const childTurn = (childThreadId: ThreadId, ordinal: number) =>
    ({
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        id: ProviderTurnId.make(`provider-turn:${childThreadId}:${ordinal}`),
        providerThreadId: providerThreadOf(childThreadId),
        runAttemptId: null,
        status: "running",
      },
    }) as ProviderAdapter.ProviderAdapterV2Event;
  const ended = RunExecutionService.routeProviderEvent(
    {
      type: "turn.terminal",
      driver,
      providerThreadId: identity.providerThreadId,
      providerTurnId: rootProviderTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    },
    identity,
    RunExecutionService.makeProviderEventRoutingState({
      identity,
      providerTurnId: rootProviderTurnId,
      relatedThreadIds: [resumedChild, siblingChild],
      relatedProviderThreadIds: [providerThreadOf(resumedChild), providerThreadOf(siblingChild)],
    }),
  )[1];
  const [firstTurnAccepted, withChildTurn] = RunExecutionService.routeProviderEvent(
    childTurn(resumedChild, 1),
    identity,
    ended,
  );
  assert.isTrue(firstTurnAccepted);
  const [movedAccepted, afterMove] = RunExecutionService.routeProviderEvent(
    {
      type: "subagent.updated",
      driver,
      subagent: subagent(resumedChild, RunId.make("run:handoff:2")),
    },
    identity,
    withChildTurn,
  );
  assert.isFalse(movedAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childMessage(resumedChild), identity, afterMove)[0],
  );
  assert.isTrue(
    RunExecutionService.routeProviderEvent(childMessage(siblingChild), identity, afterMove)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childTurn(resumedChild, 1), identity, afterMove)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childTurn(resumedChild, 2), identity, afterMove)[0],
  );
  assert.isTrue(
    RunExecutionService.routeProviderEvent(childTurn(siblingChild, 1), identity, afterMove)[0],
  );
  assert.isTrue(
    RunExecutionService.routeProviderEvent(
      { type: "subagent.updated", driver, subagent: subagent(siblingChild, identity.runId) },
      identity,
      afterMove,
    )[0],
  );
  const resuming: RunExecutionService.ProviderEventRouteIdentity = {
    ...identity,
    runId: RunId.make("run:handoff:2"),
    attemptId: RunAttemptId.make("attempt:handoff:2"),
  };
  const resumingState = RunExecutionService.makeProviderEventRoutingState({
    identity: resuming,
    providerTurnId: ProviderTurnId.make("provider-turn:handoff:2"),
  });
  assert.isFalse(
    RunExecutionService.routeProviderEvent(childMessage(resumedChild), resuming, resumingState)[0],
  );
  const [moveAccepted, afterTake] = RunExecutionService.routeProviderEvent(
    { type: "subagent.updated", driver, subagent: subagent(resumedChild, resuming.runId) },
    resuming,
    resumingState,
  );
  assert.isTrue(moveAccepted);
  assert.isTrue(
    RunExecutionService.routeProviderEvent(childMessage(resumedChild), resuming, afterTake)[0],
  );
});

it("does not route a superseded attempt through a reused provider thread", () => {
  const threadId = ThreadId.make("thread:shared-runtime:restart");
  const providerThreadId = ProviderThreadId.make("provider-thread:shared-runtime:restart");
  const oldAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:shared-runtime:restart"),
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:old"),
    providerThreadId,
  };
  const newAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    ...oldAttempt,
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:new"),
  };
  const oldTurnEvent: ProviderAdapter.ProviderAdapterV2Event = {
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

  const newState = RunExecutionService.makeProviderEventRoutingState({
    identity: newAttempt,
    providerTurnId: null,
  });
  assert.isFalse(RunExecutionService.routeProviderEvent(oldTurnEvent, newAttempt, newState)[0]);
});

it("routes only exact same-thread background items inherited from settled runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-routing");
  const otherThreadId = ThreadId.make("thread:inherited-background-routing:other");
  const priorRunId = RunId.make("run:inherited-background-routing:prior");
  const currentRunId = RunId.make("run:inherited-background-routing:current");
  const itemId = TurnItemId.make("turn-item:inherited-background-routing");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: currentRunId,
    attemptId: RunAttemptId.make("attempt:inherited-background-routing:current"),
    providerThreadId: ProviderThreadId.make("provider-thread:inherited-background-routing:current"),
  };
  const initial = RunExecutionService.makeProviderEventRoutingState({
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
  } as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>;
  const unrelatedRunItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      runId: RunId.make("run:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const unlistedPriorItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      id: TurnItemId.make("turn-item:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const unrelatedThreadItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, threadId: otherThreadId },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const ordinaryItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, type: "reasoning" as const },
  } as ProviderAdapter.ProviderAdapterV2Event;
  const inheritedTerminal = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, status: "completed" as const },
  } as ProviderAdapter.ProviderAdapterV2Event;

  const [runningAccepted, afterRunning] = RunExecutionService.routeProviderEvent(
    inheritedRunning,
    identity,
    initial,
  );
  assert.isTrue(runningAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedRunItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unlistedPriorItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedThreadItem, identity, afterRunning)[0],
  );
  assert.isFalse(RunExecutionService.routeProviderEvent(ordinaryItem, identity, afterRunning)[0]);

  const [terminalAccepted, afterTerminal] = RunExecutionService.routeProviderEvent(
    inheritedTerminal,
    identity,
    afterRunning,
  );
  assert.isTrue(terminalAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(inheritedRunning, identity, afterTerminal)[0],
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

  const selected = RunExecutionService.selectInheritedBackgroundTurnItems({
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

it("does not carry interrupted or still-running child ownership into later attempts", () => {
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("interrupted"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("failed"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("cancelled"));
  assert.isTrue(RunExecutionService.canRouteRelatedSubagent("completed"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("running"));

  const threadId = ThreadId.make("thread:related-child:next-attempt");
  const childThreadId = ThreadId.make("thread:related-child:interrupted");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:related-child:next-attempt"),
    attemptId: RunAttemptId.make("attempt:related-child:next-attempt"),
    providerThreadId: ProviderThreadId.make("provider-thread:related-child:next-attempt"),
  };
  const state = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: null,
    relatedThreadIds: RunExecutionService.canRouteRelatedSubagent("interrupted")
      ? [childThreadId]
      : [],
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
  } satisfies ProviderAdapter.ProviderAdapterV2Event;

  assert.isFalse(RunExecutionService.routeProviderEvent(lateChildNode, identity, state)[0]);
});

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
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
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

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
  }).pipe(Effect.provide(layerRunExecutionTest)),
);

it.effect("passes the thread's MCP app context to the provider under a safe key", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const started = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2TurnInput>();
    const threadId = ThreadId.make("thread:run-execution-app-context");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const attemptId = RunAttemptId.make("attempt:run-execution-app-context");
    const session = {
      events: Stream.never,
      startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Deferred.succeed(started, input),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-app-context"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId: ProviderSessionId.make("session:run-execution-app-context"),
      session,
      run: {
        id: RunId.make("run:run-execution-app-context"),
        threadId,
        ordinal: 1,
        providerInstanceId,
      } as OrchestrationV2Run,
      rootNode: {
        id: NodeId.make("node:run-execution-app-context"),
      } as OrchestrationV2ExecutionNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-app-context"),
      } as OrchestrationV2CheckpointScope,
      providerThread: {
        id: ProviderThreadId.make("provider-thread:run-execution-app-context"),
        driver,
      } as OrchestrationV2ProviderThread,
      attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
      attemptId,
      providerTurnOrdinal: 1,
      message: {
        messageId: MessageId.make("message:run-execution-app-context"),
        text: "What is on my list?",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: process.cwd() },
    });

    const input = yield* Deferred.await(started);
    assert.deepEqual(input.appContext, [
      { key: "mcp_app_turn-item_provider_codex_native-item_call-1", text: "2 overdue" },
    ]);
  }).pipe(
    Effect.provide(
      RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(McpAppModelContext.McpAppModelContext)({
              forThread: () =>
                Effect.succeed([
                  {
                    itemId: "turn-item:provider:codex:native-item:call-1",
                    server: "my tools>",
                    tool: "list",
                    text: "2 overdue",
                  },
                ]),
            }),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({}),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      ),
    ),
  ),
);

it.effect("fails the run when its ownership check cannot be read before calling the provider", () =>
  Effect.gen(function* () {
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const threadId = ThreadId.make("thread:run-execution-start-guard-read");
    const runId = RunId.make("run:run-execution-start-guard-read");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard-read");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (input) =>
              Ref.update(writes, (current) => [...current, ...input.events]).pipe(
                Effect.as({ committed: true, storedEvents: [] }),
              ),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-start-guard-read"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make("session:run-execution-start-guard-read"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-start-guard-read"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard-read"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-start-guard-read"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        shouldStartProviderTurn: () =>
          Ref.getAndUpdate(guardCalls, (calls) => calls + 1).pipe(
            Effect.flatMap((calls) =>
              calls === 0
                ? Effect.succeed(true)
                : Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "database unavailable",
                    }),
                  ),
            ),
          ),
        shouldFinalizeRun: () =>
          Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId,
              cause: "database unavailable",
            }),
          ),
        message: {
          messageId: MessageId.make("message:run-execution-start-guard-read"),
          text: "Start while the store is down.",
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

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
    const runUpdate = (yield* Ref.get(writes)).find((event) => event.type === "run.updated");
    assert.equal(
      runUpdate?.type === "run.updated" ? runUpdate.payload.status : undefined,
      "failed",
    );
  }),
);

it.effect(
  "dispatches only attachment-free compact commands through the native compaction path",
  () =>
    Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const calls: Array<string> = [];
      const attachment = ChatFileAttachment.make({
        type: "file",
        id: ChatAttachmentId.make("compact-file-12345678-1234-1234-1234-123456789abc"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      });
      const cases = [
        { text: " /compact ", attachments: [], expected: "compact" },
        { text: "/compact", attachments: [attachment], expected: "prompt" },
        { text: "Continue the work", attachments: [], expected: "prompt" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const threadId = ThreadId.make(`thread:compact-routing:${index}`);
        const attemptId = RunAttemptId.make(`attempt:compact-routing:${index}`);
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:compact-routing:${index}`),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:compact-routing:${index}`),
          session: {
            events: Stream.never,
            startTurn: () =>
              Effect.sync(() => {
                calls.push("prompt");
              }),
            compactThread: () =>
              Effect.sync(() => {
                calls.push("compact");
              }),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: RunId.make(`run:compact-routing:${index}`),
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as OrchestrationV2Run,
          rootNode: {
            id: NodeId.make(`node:compact-routing:${index}`),
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint:compact-routing:${index}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ProviderThreadId.make(`provider-thread:compact-routing:${index}`),
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:compact-routing:${index}`),
            text: testCase.text,
            attachments: testCase.attachments,
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
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
      }
      assert.deepEqual(
        calls,
        cases.map((testCase) => testCase.expected),
      );
    }).pipe(Effect.provide(layerRunExecutionTest)),
);

it.effect("starts the provider when checkpoint baseline capture fails", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-baseline-failure");
    const runId = RunId.make("run:run-execution-baseline-failure");
    const attemptId = RunAttemptId.make("attempt:run-execution-baseline-failure");
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-baseline-failure",
    );
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-baseline-failure");
    const rootNodeId = NodeId.make("node:run-execution-baseline-failure");
    const checkpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:run-execution-baseline-failure"),
    } as OrchestrationV2CheckpointScope;
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<
      ReadonlyArray<{
        events: ReadonlyArray<OrchestrationV2DomainEvent>;
        effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      }>
    >([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () =>
              Effect.fail(
                new CheckpointService.CheckpointBaselineCaptureError({
                  scopeId: checkpointScope.id,
                  ordinalWithinScope: 0,
                  cause: new Error("VCS process timed out"),
                }),
              ),
          }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Ref.update(writes, (current) => [
                ...current,
                { events: input.events, effects: input.effects },
              ]).pipe(Effect.as([])),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-baseline-failure"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-baseline-failure"),
          text: "Start the provider without a baseline.",
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

    assert.equal(yield* Ref.get(providerStarts), 1);

    const events = (yield* Ref.get(writes)).flatMap((write) => [...write.events]);
    const failedEvent = events.find(
      (event) =>
        (event.type === "run.updated" ||
          event.type === "run-attempt.updated" ||
          event.type === "node.updated") &&
        event.payload.status === "failed",
    );
    assert.isUndefined(failedEvent);
    const errorItem = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "error",
    );
    assert.isUndefined(errorItem);
  }),
);

it.effect.each(["failure", "interruption", "stale-attempt", "start-guard"] as const)(
  "handles %s before the provider turn starts",
  (scenario) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:run-execution-settings-failure");
      const runId = RunId.make("run:run-execution-settings-failure");
      const attemptId = RunAttemptId.make("attempt:run-execution-settings-failure");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("session:run-execution-settings-failure");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:run-execution-settings-failure",
      );
      const rootNodeId = NodeId.make("node:run-execution-settings-failure");
      const checkpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-settings-failure"),
      } as OrchestrationV2CheckpointScope;
      const providerStarts = yield* Ref.make(0);
      const refreshes = yield* Ref.make(0);
      const guardedWrites = yield* Ref.make(0);
      const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>([]);
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () =>
                scenario === "start-guard" ? Effect.void : Effect.die("not reached"),
            }),
            layerTurnItemPositionsTest,
            Layer.mock(EventSink.EventSinkV2)({
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  assert.equal(input.threadId, threadId);
                  assert.equal(input.runId, runId);
                  assert.equal(input.activeAttemptId, attemptId);
                  assert.equal(input.expectedStatus, "running");
                  yield* Ref.update(guardedWrites, (count) => count + 1);
                  if (scenario === "stale-attempt") {
                    return { committed: false, storedEvents: [] };
                  }
                  yield* Ref.update(writes, (current) => [...current, input.events]);
                  return { committed: true, storedEvents: [] };
                }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            scenario === "start-guard"
              ? ServerSettings.layerTest()
              : Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings:
                    scenario === "interruption"
                      ? Effect.interrupt
                      : Effect.fail(
                          new ServerSettingsError({
                            settingsPath: "<test>",
                            operation: "read-file",
                            cause: new Error("settings read failed"),
                          }),
                        ),
                }),
            Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
              refresh: () => Effect.void,
              refreshAfterTurn: () => Ref.update(refreshes, (count) => count + 1),
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:run-execution-settings-failure"),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId,
          session: {
            events: Stream.never,
            startTurn: () => Ref.update(providerStarts, (count) => count + 1),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            status: "running",
          } as OrchestrationV2Run,
          rootNode: { id: rootNodeId, status: "running" } as OrchestrationV2ExecutionNode,
          checkpointScope,
          providerThread: {
            id: providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: attemptId,
            providerTurnId: null,
            status: "running",
          } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          ...(scenario === "start-guard"
            ? { shouldStartProviderTurn: () => Effect.succeed(false) }
            : {}),
          message: {
            messageId: MessageId.make("message:run-execution-settings-failure"),
            text: "Start after settings fail.",
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
      }).pipe(Effect.provide(layerTest), Effect.exit);

      assert.equal(yield* Ref.get(providerStarts), 0);
      const events = (yield* Ref.get(writes)).flat();
      if (scenario === "interruption") {
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.isTrue(Exit.isSuccess(result));
      if (scenario === "start-guard") {
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(guardedWrites), 1);
      if (scenario === "stale-attempt") {
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(refreshes), 1);
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "run.updated" ||
              event.type === "run-attempt.updated" ||
              event.type === "node.updated",
          )
          .map((event) => event.payload.status),
        ["failed", "failed", "failed"],
      );
      const errorItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "error",
      );
      assert.isDefined(errorItem);
      if (errorItem?.type === "turn-item.updated" && errorItem.payload.type === "error") {
        assert.equal(errorItem.payload.failure.message, "Run preparation failed.");
      }
    }),
);

it.effect("ingests new member threads of an owned child after the root turn terminalizes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-late-child");
    const childThreadId = ThreadId.make("thread:run-execution-late-child:child");
    const memberThreadId = ThreadId.make("thread:run-execution-late-child:member");
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
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
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
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                if (
                  input.event.type === "app_thread.created" &&
                  input.event.appThread.id === memberThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "member-thread"]);
                }
                if (
                  input.event.type === "message.updated" &&
                  input.event.message.threadId === memberThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "child-message"]);
                  yield* Deferred.succeed(childMessageIngested, undefined).pipe(Effect.ignore);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
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
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          id: childProviderThreadId,
          appThreadId: childThreadId,
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          ...makeRunOwnedSubagentFixture({
            ids: backgroundScenarioIds("run-execution-late-child"),
            providerInstanceId,
            childThreadId,
            driver,
            status: "running",
          }),
          workflow: {
            phases: [],
            agents: [
              { index: 0, label: "Reviewer", state: "running", childThreadId: memberThreadId },
            ],
          },
        },
      },
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
      } as ProviderAdapter.ProviderAdapterV2Event,
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
        type: "app_thread.created",
        driver,
        appThread: {
          id: memberThreadId,
          lineage: {
            parentThreadId: childThreadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make("message:run-execution-late-child:child"),
          threadId: memberThreadId,
          runId: null,
          nodeId: childNodeId,
          role: "assistant",
          text: "Hello.",
          streaming: false,
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
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
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "completed",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-late-child"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
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
    }).pipe(Effect.provide(layerTest));

    const observed = yield* Deferred.await(childMessageIngested).pipe(
      Effect.timeoutOption("2 seconds"),
    );
    assert.isTrue(Option.isSome(observed), "child message was not ingested after root terminal");
    assert.deepEqual(yield* Ref.get(order), ["root-finalized", "member-thread", "child-message"]);
  }),
);

it.effect("ends a nested native subagent and its thread when the root run is interrupted", () =>
  Effect.gen(function* () {
    const key = "run-execution-nested-native";
    const threadId = ThreadId.make(`thread:${key}`);
    const childThreadId = ThreadId.make(`thread:${key}:child`);
    const grandchildThreadId = ThreadId.make(`thread:${key}:grandchild`);
    const runId = RunId.make(`run:${key}`);
    const attemptId = RunAttemptId.make(`attempt:${key}`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerThreadId = ProviderThreadId.make(`provider-thread:${key}`);
    const rootProviderTurnId = ProviderTurnId.make(`provider-turn:${key}`);
    const nestedId = NodeId.make(`node:${key}:nested`);
    const grandchildRootId = NodeId.make(`node:${key}:grandchild-root`);
    const finalized = yield* Deferred.make<ReadonlyArray<OrchestrationV2DomainEvent>>();
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.as(
                input.events.some((event) => event.type === "run.updated")
                  ? Deferred.succeed(finalized, input.events)
                  : Effect.void,
                [],
              ),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const subagentThread = (id: ThreadId, parentThreadId: ThreadId) =>
      ({
        type: "app_thread.created",
        driver,
        appThread: {
          id,
          lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: threadId },
        },
      }) as ProviderAdapter.ProviderAdapterV2Event;
    const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
      subagentThread(childThreadId, threadId),
      subagentThread(grandchildThreadId, childThreadId),
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: nestedId,
          threadId: childThreadId,
          runId: null,
          origin: "provider_native",
          childThreadId: grandchildThreadId,
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "node.updated",
        driver,
        node: {
          id: grandchildRootId,
          threadId: grandchildThreadId,
          runId: null,
          kind: "root_turn",
          status: "running",
        },
      } as ProviderAdapter.ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "interrupted",
        failure: null,
        threadDisposition: "reusable",
      },
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: { id: NodeId.make(`node:${key}`) } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: { id: providerThreadId, driver } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: rootProviderTurnId } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Spawn a nested subagent.",
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
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      });
    }).pipe(Effect.provide(layerTest));

    const ended = (yield* Deferred.await(finalized)).flatMap((event) =>
      event.type === "subagent.updated" || event.type === "node.updated"
        ? [[event.type, event.payload.id, event.payload.status]]
        : [],
    );
    assert.deepInclude(ended, ["subagent.updated", nestedId, "interrupted"]);
    assert.deepInclude(ended, ["node.updated", grandchildRootId, "interrupted"]);
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

it.effect.each([null, "run:nested-sdk"] as const)(
  "releases a settled run when its live child transfers to another run (%s)",
  (nestedRunId) =>
    Effect.gen(function* () {
      const consumed = yield* Deferred.make<void>();
      const result = yield* Effect.raceFirst(
        runBackgroundItemScenario(
          "child-transfer-release",
          (ids) => {
            const running = subagentEvent(ids, "running");
            if (running.type !== "subagent.updated") throw new Error("Missing subagent");
            const linked = {
              ...running,
              subagent: {
                ...running.subagent,
                origin: "provider_native" as const,
                childThreadId: ids.childThreadId,
                providerThreadId: null,
              },
            };
            return [
              childThreadCreatedEvent(ids),
              linked,
              {
                ...linked,
                subagent: {
                  ...linked.subagent,
                  id: NodeId.make("node:child-transfer-release:nested"),
                  threadId: ids.childThreadId,
                  runId: nestedRunId === null ? null : RunId.make(nestedRunId),
                  childThreadId: null,
                },
              },
              childBackgroundTurnItemEvent(ids, "running", 1),
              rootTerminalEvent(ids, "completed"),
              { ...linked, subagent: { ...linked.subagent, runId: RunId.make("run:replacement") } },
            ];
          },
          {
            keepEventStreamOpen: true,
            onEventsConsumed: Deferred.succeed(consumed, undefined).pipe(Effect.asVoid),
          },
        ).pipe(Effect.map(Option.some)),
        Deferred.await(consumed).pipe(Effect.as(Option.none())),
      );
      assert.isTrue(
        Option.isSome(result),
        "the transferred child must release its prior subscription",
      );
      if (Option.isSome(result))
        assert.deepEqual(result.value, [
          "subagent:running",
          "subagent:running",
          "turn_item:running",
          "root-finalized",
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

it.effect("refreshes inherited background items after event subscription", () =>
  Effect.gen(function* () {
    const key = "inherited-background-subscription-refresh";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const itemStatus = yield* Ref.make<OrchestrationV2TurnItem["status"]>("running");
    const loadInheritedBackgroundTurnItems = () =>
      Ref.get(itemStatus).pipe(
        Effect.map((status) =>
          RunExecutionService.selectInheritedBackgroundTurnItems({
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

it.effect("emits run_interrupt_result when hard-stop finalizes the active attempt", () =>
  Effect.gen(function* () {
    const { written, observed, committedEffects } = yield* captureRootRunTermination({
      key: "hard-stop",
      shouldFinalizeRun: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["run:interrupted", "pull-requests-refreshed"]);
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

function captureRootRunTermination(input: {
  readonly key: string;
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly rejectTerminalWrite?: boolean;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly seedOpenSubagent?: boolean;
  readonly events?: (
    ids: BackgroundScenarioIds,
  ) => Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly startTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"];
  readonly onStartFailure?: (
    error: RunExecutionService.RunExecutionServiceV2Error,
  ) => Effect.Effect<void>;
  readonly refreshAfterTurn?: Effect.Effect<void>;
  readonly onSubscriptionClose?: Effect.Effect<void>;
  readonly shouldStartProviderTurn?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["shouldStartProviderTurn"];
  readonly appContext?: ReturnType<McpAppModelContext.McpAppModelContext["Service"]["forThread"]>;
  readonly ingestNormalized?: ProviderEventIngestor.ProviderEventIngestorV2["Service"]["ingestNormalized"];
  readonly beforeTerminalWrite?: (
    request: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0],
  ) => Effect.Effect<boolean, EventSink.EventSinkV2Error>;
  readonly afterStart?: (closed: Deferred.Deferred<void>) => Effect.Effect<void>;
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
    const writtenItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
    const finalEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const submittedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const committedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: OrchestrationV2TurnItem) =>
      Ref.update(writtenItems, (current) => [...current, payload]);
    const captureFinalEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        yield* Ref.update(finalEvents, (current) => [...current, ...events]);
        for (const event of events) {
          if (event.type === "turn-item.updated") {
            yield* captureTurnItem(event.payload);
          }
          if (event.type === "run.updated") {
            yield* Ref.update(observed, (current) => [...current, `run:${event.payload.status}`]);
          }
        }
      });
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(McpAppModelContext.McpAppModelContext)({
            forThread: () => input.appContext ?? Effect.succeed([]),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
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
                yield* Ref.update(submittedEffects, (current) => [...current, ...payload.effects]);
                yield* Ref.update(committedEffects, (current) => [...current, ...payload.effects]);
                yield* captureFinalEvents(payload.events);
                return [];
              }),
            writeIfRunCurrent: (payload) =>
              Effect.gen(function* () {
                const effects = payload.effects ?? [];
                yield* Ref.update(submittedEffects, (current) => [...current, ...effects]);
                if (
                  input.rejectTerminalWrite === true ||
                  (input.beforeTerminalWrite !== undefined &&
                    !(yield* input.beforeTerminalWrite(payload)))
                ) {
                  return { committed: false, storedEvents: [] };
                }
                yield* Ref.update(committedEffects, (current) => [...current, ...effects]);
                yield* captureFinalEvents(payload.events);
                return { committed: true, storedEvents: [] };
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: input.ingestNormalized ?? (() => Effect.succeed([])),
          }),
          ServerSettings.layerTest(),
          Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshAfterTurn: () =>
              Ref.update(observed, (current) => [...current, "pull-requests-refreshed"]).pipe(
                Effect.andThen(input.refreshAfterTurn ?? Effect.void),
              ),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const start = runExecution.startRootRun({
        commandId: CommandId.make(`command:${input.key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${input.key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events:
              input.events?.(ids) ??
              Stream.fromIterable([
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
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
            close: Deferred.succeed(ingestionDone, undefined).pipe(
              Effect.andThen(input.onSubscriptionClose ?? Effect.void),
            ),
          }),
          startTurn: input.startTurn ?? (() => Effect.void),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
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
        ...(input.shouldStartProviderTurn === undefined
          ? {}
          : { shouldStartProviderTurn: input.shouldStartProviderTurn }),
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
      yield* start.pipe(
        Effect.catch((error) => input.onStartFailure?.(error) ?? Effect.fail(error)),
      );
      yield* input.afterStart?.(ingestionDone) ?? Effect.void;
      yield* Deferred.await(ingestionDone);
    }).pipe(Effect.provide(layerTest));

    return {
      written: yield* Ref.get(writtenItems),
      finalEvents: yield* Ref.get(finalEvents),
      observed: yield* Ref.get(observed),
      submittedEffects: yield* Ref.get(submittedEffects),
      committedEffects: yield* Ref.get(committedEffects),
    };
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

function childThreadCreatedEvent(
  ids: BackgroundScenarioIds,
): ProviderAdapter.ProviderAdapterV2Event {
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
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function childBackgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapter.ProviderAdapterV2Event {
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
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function backgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
  itemId?: TurnItemId,
): ProviderAdapter.ProviderAdapterV2Event {
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
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function backgroundTurnItemEventForRun(
  ids: BackgroundScenarioIds,
  runId: RunId,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapter.ProviderAdapterV2Event {
  const event = backgroundTurnItemEvent(ids, type, status, ordinal);
  if (event.type !== "turn_item.updated") {
    return event;
  }
  return { ...event, turnItem: { ...event.turnItem, runId } };
}

function subagentEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "subagent.updated",
    driver,
    subagent: {
      id: ids.subagentNodeId,
      threadId: ids.threadId,
      runId: ids.runId,
      status,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
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
  status: "completed" | "interrupted" | "cancelled" | "failed",
): ProviderAdapter.ProviderAdapterV2Event {
  const common = {
    type: "turn.terminal" as const,
    driver,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.rootProviderTurnId,
    runOrdinal: 1,
    threadDisposition: "reusable" as const,
  };
  return status === "failed"
    ? {
        ...common,
        status,
        failureItemOrdinal: 101,
        failure: {
          class: "provider_error",
          message: "Provider failed",
          code: null,
          retryable: null,
        },
      }
    : { ...common, status, failure: null };
}

function runBackgroundItemScenario(
  key: string,
  makeEvents: (ids: BackgroundScenarioIds) => ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  options?: {
    readonly keepEventStreamOpen?: boolean;
    readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
      ReadonlyArray<{ readonly id: TurnItemId; readonly runId: RunId }>
    >;
    readonly onSubscribe?: Effect.Effect<void>;
    readonly onEventsConsumed?: Effect.Effect<void>;
    readonly onFinalized?: (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) => Effect.Effect<void>;
  },
) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  yield* options?.onFinalized?.(input.events) ?? Effect.void;
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
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
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.gen(function* () {
            yield* options?.onSubscribe ?? Effect.void;
            const events = Stream.fromIterable(makeEvents(ids)).pipe(
              Stream.concat(
                Stream.fromEffect(options?.onEventsConsumed ?? Effect.void).pipe(Stream.drain),
              ),
            );
            return {
              events:
                options?.keepEventStreamOpen === true
                  ? events.pipe(Stream.concat(Stream.never))
                  : events,
              close: Deferred.succeed(ingestionDone, undefined),
            };
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
    }).pipe(Effect.provide(layerTest));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");
    return yield* Ref.get(observed);
  });
}

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
