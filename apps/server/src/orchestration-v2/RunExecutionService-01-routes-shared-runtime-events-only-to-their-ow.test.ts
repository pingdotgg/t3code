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
