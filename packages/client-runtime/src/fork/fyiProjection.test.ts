import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { applyOrchestrationV2ProjectionEvent } from "../state/orchestrationV2Projection.ts";

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

describe("applyOrchestrationV2ProjectionEvent partial timeline", () => {
  const queuedRunId = RunId.make("run-queued");
  const queuedRun = { ...run, id: queuedRunId, ordinal: 2, status: "queued" } as const;
  const runItem = (id: string, itemRunId: RunId, ordinal: number): OrchestrationV2TurnItem => ({
    id: TurnItemId.make(id),
    threadId,
    runId: itemRunId,
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
    output: id,
    exitCode: 0,
  });
  const windowOf = (
    runs: ReadonlyArray<OrchestrationV2Run>,
    items: ReadonlyArray<OrchestrationV2TurnItem>,
  ): OrchestrationV2ThreadProjection => ({
    ...emptyProjection,
    runs,
    turnItems: items,
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
  });
  const itemEvent = (payload: OrchestrationV2TurnItem) =>
    ({
      id: `event-${payload.id}`,
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload,
    }) as OrchestrationV2DomainEvent;

  it("keeps an FYI sent while a queued run's message raised the watermark, not an older one a run took or a rollback returned", () => {
    const first = runItem("item-first", runId, 1_000_001);
    const queuedUser = runItem("item-queued-user", queuedRunId, 2_000_001);
    const fyi: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item-fyi"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1_000_002,
      status: "pending",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "user_message",
      messageId: MessageId.make("message-fyi"),
      createdBy: "agent",
      creationSource: "mcp",
      inputIntent: "steer",
      text: "main moved",
      attachments: [],
      fyi: true,
    };
    const projection = windowOf([run, queuedRun], [first, queuedUser]);

    const next = applyOrchestrationV2ProjectionEvent(projection, itemEvent(fyi), {
      partialTimeline: true,
      latestLocalTurnOrdinal: queuedUser.ordinal,
    });

    expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
      first.id,
      fyi.id,
      queuedUser.id,
    ]);

    // Bound from below the window, it would land on top here but not after a reload.
    const runningRun = { ...queuedRun, status: "running" } as const;
    const older = { ...fyi, id: TurnItemId.make("item-fyi-older"), ordinal: 5 };
    const window = windowOf([run, runningRun], [first, queuedUser]);
    expect(
      applyOrchestrationV2ProjectionEvent(
        window,
        itemEvent({ ...older, runId: queuedRunId, nodeId: null, status: "completed" }),
        { partialTimeline: true, latestLocalTurnOrdinal: queuedUser.ordinal },
      ),
    ).toBe(window);
    expect(
      applyOrchestrationV2ProjectionEvent(window, itemEvent(older), {
        partialTimeline: true,
        latestLocalTurnOrdinal: queuedUser.ordinal,
      }),
    ).toBe(window);
  });
});
