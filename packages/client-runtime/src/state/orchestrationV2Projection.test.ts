import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import {
  canDetachThreadProviderSession,
  threadSupportsProviderHandoff,
} from "./threadWorkflows.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-reducer");
const runId = RunId.make("run-reducer");
const run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-reducer"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

function commandItem(id: string, output = "done", ordinal = 1): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "pwd",
    output,
    exitCode: 0,
  };
}
const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-reducer"),
    title: "Reducer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
} as OrchestrationV2ThreadProjection;

const detachedSessionId = ProviderSessionId.make("session-detached");
const currentSessionId = ProviderSessionId.make("session-current");
const staleProviderThreadId = ProviderThreadId.make("provider-thread-stale");
const currentProviderThreadId = ProviderThreadId.make("provider-thread-current");
const foreignProviderThreadId = ProviderThreadId.make("provider-thread-foreign");
const queuedProviderThreadId = ProviderThreadId.make("provider-thread-queued");
const currentSession = {
  id: currentSessionId,
  driver: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  status: "ready",
  cwd: "/workspace",
  model: "gpt-5.4",
  capabilities: {
    sessions: { supportsProviderSwitchingViaHandoff: true },
  },
  createdAt: now,
  updatedAt: now,
  lastError: null,
} as OrchestrationV2ThreadProjection["providerSessions"][number];

function providerThread(
  input: Pick<
    OrchestrationV2ProviderThread,
    "id" | "appThreadId" | "providerSessionId" | "status" | "firstRunOrdinal" | "nativeThreadRef"
  >,
): OrchestrationV2ProviderThread {
  return {
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    ownerNodeId: null,
    nativeConversationHeadRef: null,
    lastRunOrdinal: input.firstRunOrdinal,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function providerThreadUpdatedEvent(
  payload: OrchestrationV2ProviderThread,
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${String(payload.id)}`),
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload,
  };
}

describe("applyOrchestrationV2ProjectionEvent", () => {
  it("keeps live token usage when the terminal provider turn omits it", () => {
    const providerTurnId = ProviderTurnId.make("provider-turn-reducer");
    const running = {
      id: providerTurnId,
      providerThreadId: ProviderThreadId.make("provider-thread-reducer"),
      nodeId: NodeId.make("provider-node-reducer"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 50_000,
        maxTokens: 200_000,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    };
    const projection = { ...emptyProjection, providerTurns: [running] };
    const event = {
      id: "event-provider-turn-terminal",
      type: "provider-turn.updated",
      threadId,
      driver: "codex",
      occurredAt: now,
      payload: {
        ...running,
        status: "completed",
        completedAt: now,
        tokenUsage: undefined,
      },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);

    expect(next?.providerTurns[0]?.status).toBe("completed");
    expect(next?.providerTurns[0]?.tokenUsage).toEqual(running.tokenUsage);
  });

  it("applies thread lifecycle payloads instead of leaving stale metadata", () => {
    const archivedAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const event = {
      id: "event-archive",
      type: "thread.archived",
      threadId,
      occurredAt: archivedAt,
      payload: { ...emptyProjection.thread, archivedAt, updatedAt: archivedAt },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(emptyProjection, event);
    expect(next?.thread.archivedAt).toEqual(archivedAt);
    expect(next?.updatedAt).toEqual(archivedAt);
  });

  it("ignores events for another thread", () => {
    const event = {
      id: "event-other",
      type: "thread.deleted",
      threadId: ThreadId.make("thread-other"),
      occurredAt: now,
      payload: { ...emptyProjection.thread, id: ThreadId.make("thread-other"), deletedAt: now },
    } as OrchestrationV2DomainEvent;

    expect(applyOrchestrationV2ProjectionEvent(emptyProjection, event)).toBe(emptyProjection);
  });

  it("preserves visible row identity when run updates do not change membership", () => {
    const item = commandItem("item-stable");
    const visibleTurnItems = [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      },
    ];
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [item],
      visibleTurnItems,
    };
    const event = {
      id: "event-run-update",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "completed" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toBe(visibleTurnItems);
    expect(next?.visibleTurnItems[0]).toBe(visibleTurnItems[0]);
  });

  it("replaces only the updated visible item when membership is unchanged", () => {
    const first = commandItem("item-first", "first");
    const second = commandItem("item-second", "second");
    const firstRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: first.id,
      item: first,
    };
    const secondRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: second.id,
      item: second,
    };
    const updated = commandItem("item-first", "streamed output");
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [first, second],
      visibleTurnItems: [firstRow, secondRow],
    };
    const event = {
      id: "event-item-update",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: updated,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).not.toBe(projection.visibleTurnItems);
    expect(next?.visibleTurnItems[0]).not.toBe(firstRow);
    expect(next?.visibleTurnItems[0]?.item).toBe(updated);
    expect(next?.visibleTurnItems[1]).toBe(secondRow);
  });

  it("inserts live turn items by authoritative ordinal", () => {
    const queuedFuture = commandItem("item-queued-future", "queued", 300);
    const activeAssistant = commandItem("item-active-assistant", "done", 201);
    const queuedRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: queuedFuture.id,
      item: queuedFuture,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [queuedFuture],
      visibleTurnItems: [queuedRow],
    };
    const event = {
      id: "event-active-assistant",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: activeAssistant,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
      activeAssistant.id,
      queuedFuture.id,
    ]);
    expect(next?.visibleTurnItems.map((row) => row.position)).toEqual([0, 1]);
  });

  it("removes only hidden local items while preserving inherited rows", () => {
    const inherited = commandItem("item-inherited");
    const local = commandItem("item-local");
    const inheritedRow = {
      position: 0,
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("thread-source"),
      sourceItemId: inherited.id,
      item: inherited,
    };
    const localRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: local.id,
      item: local,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [local],
      visibleTurnItems: [inheritedRow, localRow],
    };
    const event = {
      id: "event-run-rollback",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "rolled_back" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toEqual([inheritedRow]);
    expect(next?.visibleTurnItems[0]).toBe(inheritedRow);
  });

  it("binds activeProviderThreadId on provider-thread.updated so workflows see the current session", () => {
    const staleThread = providerThread({
      id: staleProviderThreadId,
      appThreadId: threadId,
      providerSessionId: detachedSessionId,
      status: "idle",
      firstRunOrdinal: 1,
      nativeThreadRef: null,
    });
    const currentThread = providerThread({
      id: currentProviderThreadId,
      appThreadId: threadId,
      providerSessionId: currentSessionId,
      status: "idle",
      firstRunOrdinal: 2,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "native-current",
        strength: "strong",
      },
    });
    const projection = {
      ...emptyProjection,
      thread: { ...emptyProjection.thread, activeProviderThreadId: staleProviderThreadId },
      runs: [run],
      providerSessions: [currentSession],
      providerThreads: [staleThread],
    };
    expect(canDetachThreadProviderSession(projection)).toBe(false);
    expect(threadSupportsProviderHandoff(projection)).toBe(false);

    const next = applyOrchestrationV2ProjectionEvent(
      projection,
      providerThreadUpdatedEvent(currentThread),
    );

    expect(next?.thread.activeProviderThreadId).toBe(currentProviderThreadId);
    expect(next?.providerThreads.map((thread) => thread.id)).toEqual([
      staleProviderThreadId,
      currentProviderThreadId,
    ]);
    expect(canDetachThreadProviderSession(next!)).toBe(true);
    expect(threadSupportsProviderHandoff(next!)).toBe(true);
  });

  it("does not steal activeProviderThreadId for a foreign app thread or queued placeholder", () => {
    const staleThread = providerThread({
      id: staleProviderThreadId,
      appThreadId: threadId,
      providerSessionId: detachedSessionId,
      status: "idle",
      firstRunOrdinal: 1,
      nativeThreadRef: null,
    });
    const projection = {
      ...emptyProjection,
      thread: { ...emptyProjection.thread, activeProviderThreadId: staleProviderThreadId },
      runs: [run],
      providerSessions: [currentSession],
      providerThreads: [staleThread],
    };
    const foreignThread = providerThread({
      id: foreignProviderThreadId,
      appThreadId: ThreadId.make("thread-other"),
      providerSessionId: currentSessionId,
      status: "idle",
      firstRunOrdinal: 1,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "native-foreign",
        strength: "strong",
      },
    });
    const queuedPlaceholder = providerThread({
      id: queuedProviderThreadId,
      appThreadId: threadId,
      providerSessionId: null,
      status: "not_loaded",
      firstRunOrdinal: null,
      nativeThreadRef: null,
    });

    const afterForeign = applyOrchestrationV2ProjectionEvent(
      projection,
      providerThreadUpdatedEvent(foreignThread),
    );
    expect(afterForeign?.thread.activeProviderThreadId).toBe(staleProviderThreadId);
    expect(afterForeign?.providerThreads.map((thread) => thread.id)).toEqual([
      staleProviderThreadId,
      foreignProviderThreadId,
    ]);
    expect(canDetachThreadProviderSession(afterForeign!)).toBe(false);
    expect(threadSupportsProviderHandoff(afterForeign!)).toBe(false);

    const afterQueued = applyOrchestrationV2ProjectionEvent(
      afterForeign,
      providerThreadUpdatedEvent(queuedPlaceholder),
    );
    expect(afterQueued?.thread.activeProviderThreadId).toBe(staleProviderThreadId);
    expect(afterQueued?.providerThreads.map((thread) => thread.id)).toEqual([
      staleProviderThreadId,
      foreignProviderThreadId,
      queuedProviderThreadId,
    ]);
    expect(canDetachThreadProviderSession(afterQueued!)).toBe(false);
    expect(threadSupportsProviderHandoff(afterQueued!)).toBe(false);
  });
});

it("does not scan every row against every run for a streaming item update", () => {
  let runReads = 0;
  const runs = Array.from({ length: 100 }, (_, index) => ({
    ...run,
    get id() {
      runReads++;
      return RunId.make(`run-${index}`);
    },
  }));
  const items = Array.from({ length: 1000 }, (_, index) =>
    commandItem(`item-${index}`, "before", index),
  );
  const projection = {
    ...emptyProjection,
    runs,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      item,
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
    })),
  };
  const payload = commandItem("item-999", "after", 999);
  const next = applyOrchestrationV2ProjectionEvent(projection, {
    id: "stream-update",
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  } as OrchestrationV2DomainEvent);
  expect(next?.visibleTurnItems.at(-1)?.item).toBe(payload);
  expect(next?.visibleTurnItems[0]).toBe(projection.visibleTurnItems[0]);
  expect(runReads).toBeLessThanOrEqual(100);
});
