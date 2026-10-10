import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";

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

  describe("partial timeline", () => {
    const queuedRunId = RunId.make("run-queued");
    const steerRunId = RunId.make("run-steer");
    const queuedRun = { ...run, id: queuedRunId, ordinal: 2, status: "queued" } as const;
    const steerRun = { ...run, id: steerRunId, ordinal: 3, status: "completed" } as const;
    const runItem = (id: string, itemRunId: RunId, ordinal: number) => ({
      ...commandItem(id, id, ordinal),
      runId: itemRunId,
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
    const runEvent = (payload: OrchestrationV2Run) =>
      ({
        id: `event-${payload.id}-${payload.status}`,
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload,
      }) as OrchestrationV2DomainEvent;

    it("shows a queued run that starts after a newer steer raised the watermark", () => {
      // Run 2 was queued first, run 3 was steered in and ran first. Its items
      // sit in run 3's band and already raised the watermark past run 2's band.
      const steerItems = [
        runItem("item-steer-user", steerRunId, 3_000_001),
        runItem("item-steer-reply", steerRunId, 3_000_002),
      ];
      let projection: OrchestrationV2ThreadProjection | null = windowOf(
        [run, queuedRun, steerRun],
        steerItems,
      );
      let latestLocalTurnOrdinal = 3_000_002;
      // Same order the orchestrator commits a queued start: the user message
      // lands while the run is still queued, then the run starts and replies.
      const queuedUser = runItem("item-queued-user", queuedRunId, 2_000_001);
      const queuedReply = runItem("item-queued-reply", queuedRunId, 2_000_002);
      for (const event of [
        itemEvent(queuedUser),
        runEvent({ ...queuedRun, status: "running" }),
        itemEvent(queuedReply),
        runEvent({ ...queuedRun, status: "completed" }),
      ]) {
        projection = applyOrchestrationV2ProjectionEvent(projection, event, {
          partialTimeline: true,
          latestLocalTurnOrdinal,
        });
        if (event.type === "turn-item.updated") {
          latestLocalTurnOrdinal = Math.max(latestLocalTurnOrdinal, event.payload.ordinal);
        }
      }

      expect(projection?.visibleTurnItems.map((row) => row.item.id)).toEqual([
        queuedUser.id,
        queuedReply.id,
        ...steerItems.map((item) => item.id),
      ]);
      expect(projection?.turnItems.map((item) => item.id)).toContain(queuedReply.id);
    });

    it("keeps a running run's item when the window starts after its earlier items", () => {
      // The bounded window begins inside run 3; run 2 started and kept going,
      // but none of its rows made it into the window.
      const runningRun = { ...queuedRun, status: "running" } as const;
      const steerItems = [
        runItem("item-steer-user", steerRunId, 3_000_001),
        runItem("item-steer-reply", steerRunId, 3_000_002),
      ];
      const projection = windowOf([run, runningRun, steerRun], steerItems);
      const reply = runItem("item-running-reply", queuedRunId, 2_000_003);

      const next = applyOrchestrationV2ProjectionEvent(projection, itemEvent(reply), {
        partialTimeline: true,
        latestLocalTurnOrdinal: 3_000_002,
      });

      expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
        reply.id,
        ...steerItems.map((item) => item.id),
      ]);
    });

    it.each([
      { name: "keeps an item of a run already in the window", itemRunId: steerRunId, kept: true },
      { name: "drops an item of a finished run outside the window", itemRunId: runId, kept: false },
    ])("$name that arrives below the watermark", ({ itemRunId, kept }) => {
      const first = runItem("item-first", steerRunId, 3_000_001);
      const later = runItem("item-later", steerRunId, 3_000_003);
      const late = runItem("item-late", itemRunId, 3_000_002);
      const projection = windowOf([run, steerRun], [first, later]);

      const next = applyOrchestrationV2ProjectionEvent(projection, itemEvent(late), {
        partialTimeline: true,
        latestLocalTurnOrdinal: later.ordinal,
      });
      if (kept) {
        expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
          first.id,
          late.id,
          later.id,
        ]);
      } else {
        expect(next).toBe(projection);
      }
    });
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
