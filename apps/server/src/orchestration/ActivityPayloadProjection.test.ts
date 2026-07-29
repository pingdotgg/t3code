import {
  DEFAULT_EXECUTOR_MAX_SUB_AGENTS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";

function activity(
  id: string,
  itemType: string,
  data: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: `Completed ${itemType}`,
    payload: {
      itemType,
      title: itemType,
      detail: `${itemType} detail`,
      status: "completed",
      requestKind: "command",
      data,
    },
    turnId: TurnId.make(`turn-${id}`),
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("projectActivityPayload", () => {
  it("retains compact command, file, correlation, and output fields", () => {
    const source = activity("command", "command_execution", {
      item: {
        command: ["bash", "-lc", "pnpm test"],
        input: { command: "fallback input", ignored: "input bulk" },
        result: { command: "fallback result", aggregatedOutput: "x".repeat(10_000) },
        changes: [{ oldPath: "src/old.ts", newPath: "src/new.ts", patch: "patch".repeat(5_000) }],
      },
      command: "fallback data",
      kind: "execute",
      toolCallId: "tool-command",
      rawOutput: {
        content: "\n```\nfirst useful line\nsecond line",
        ignored: "raw bulk",
      },
      ignored: "top-level bulk",
    });

    expect(projectActivityPayload(source).payload).toEqual({
      itemType: "command_execution",
      title: "command_execution",
      detail: "command_execution detail",
      status: "completed",
      requestKind: "command",
      data: {
        item: {
          command: ["bash", "-lc", "pnpm test"],
          input: { command: "fallback input" },
          result: { command: "fallback result" },
        },
        command: "fallback data",
        files: [{ path: "src/new.ts" }, { path: "src/old.ts" }],
        toolCallId: "tool-command",
        kind: "execute",
        rawOutput: { content: "first useful line" },
      },
    });
  });

  it("cuts large non-MCP activity payloads by more than ninety percent", () => {
    const source = activity("large", "command_execution", {
      item: {
        command: ["bash", "-lc", "pnpm test"],
        aggregatedOutput: "x".repeat(100_000),
      },
      rawOutput: { content: `summary\n${"y".repeat(100_000)}` },
    });
    const originalBytes = JSON.stringify(source).length;
    const projectedBytes = JSON.stringify(projectActivityPayload(source)).length;

    expect(projectedBytes).toBeLessThan(originalBytes / 10);
  });

  it("passes MCP payloads through because clients render their structured data", () => {
    const source = activity("mcp", "mcp_tool_call", {
      item: { server: "repository", tool: "search", arguments: { query: "projection" } },
    });
    expect(projectActivityPayload(source)).toBe(source);
  });

  it("projects activity events without mutating the persisted event value", () => {
    const source = activity("event", "dynamic_tool_call", {
      toolCallId: "tool-event",
      rawOutput: { stdout: `result\n${"z".repeat(10_000)}` },
      ignored: "bulk",
    });
    const event = {
      sequence: 8,
      eventId: EventId.make("event-activity"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-07-27T00:00:01.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        activity: source,
      },
    } as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projected = projectActivityEvent(event);
    expect(projected).not.toBe(event);
    expect(event.payload.activity).toBe(source);
    expect(
      projected.type === "thread.activity-appended" ? projected.payload.activity : undefined,
    ).toEqual(projectActivityPayload(source));
  });
});

const makeImageActivity = (item: Record<string, unknown>): OrchestrationThreadActivity => ({
  id: EventId.make("activity-image-1"),
  tone: "tool",
  kind: "tool.completed",
  summary: "Image view",
  payload: {
    itemType: "image_view",
    detail: "/tmp/generated.png",
    data: { completedAtMs: 1, item },
  },
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-07-27T21:17:50.000Z",
});

const projectedItem = (activity: OrchestrationThreadActivity): Record<string, unknown> => {
  const payload = activity.payload as { data?: { item?: Record<string, unknown> } };
  return payload.data?.item ?? {};
};

describe("image view projection", () => {
  it("keeps the saved path for generated images while pruning the base64 result", () => {
    const projected = projectActivityPayload(
      makeImageActivity({
        id: "call-1",
        type: "imageGeneration",
        savedPath: "/Users/test/.codex/generated_images/thread/call.png",
        revisedPrompt: "a prompt",
        result: "iVBORw0KGgoAAAANSUhEUg",
        status: "completed",
      }),
    );

    const item = projectedItem(projected);
    expect(item.savedPath).toBe("/Users/test/.codex/generated_images/thread/call.png");
    expect(item.type).toBe("imageGeneration");
    // The generated image bytes are megabytes per activity and unread by clients.
    expect(item.result).toBeUndefined();
    expect(item.revisedPrompt).toBeUndefined();
  });

  it("keeps the viewed path for image view items", () => {
    const projected = projectActivityPayload(
      makeImageActivity({ id: "call-2", type: "imageView", path: "/tmp/screenshot.png" }),
    );

    const item = projectedItem(projected);
    expect(item.path).toBe("/tmp/screenshot.png");
    expect(item.type).toBe("imageView");
  });

  it("still prunes unrelated tool item payloads", () => {
    const projected = projectActivityPayload(
      makeImageActivity({ id: "call-3", type: "somethingElse", secret: "value" }),
    );

    expect(projectedItem(projected)).toEqual({});
  });
});

function makeThread(activities: ReadonlyArray<OrchestrationThreadActivity>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-projection"),
    projectId: ProjectId.make("project-projection"),
    title: "Activity projection",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    executorModelSelection: null,
    executorMaxSubAgents: DEFAULT_EXECUTOR_MAX_SUB_AGENTS,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    latestTurn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    autoReviewPhase: null,
    messages: [],
    proposedPlans: [],
    activities,
    checkpoints: [],
    session: null,
  };
}

describe("context-window snapshot dedup", () => {
  function makeContextWindowActivity(
    id: string,
    usedTokens: number,
    turn = `turn-${id}`,
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(id),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens, maxTokens: 200_000 },
      turnId: TurnId.make(turn),
      createdAt: "2026-07-27T00:00:00.000Z",
    };
  }

  it("keeps only the latest context-window activity per turn in snapshots", () => {
    const stale1 = makeContextWindowActivity("ctx-1", 1_000, "turn-a");
    const latestA = makeContextWindowActivity("ctx-2", 2_000, "turn-a");
    const latestB = makeContextWindowActivity("ctx-3", 3_000, "turn-b");
    const tool = activity("tool-ctx", "command_execution", {
      item: { command: ["bash", "-lc", "true"] },
    });

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([stale1, tool, latestA, latestB]),
    });

    expect(projected.thread.activities.map((row) => row.id)).toEqual([
      tool.id,
      latestA.id,
      latestB.id,
    ]);
    // The retained rows keep their payloads untouched — the tool-data
    // projection only rewrites payloads with a `data` record.
    expect(projected.thread.activities[2]?.payload).toEqual(latestB.payload);
  });

  it("keeps each surviving turn's latest row so a revert can still resolve a value", () => {
    // A live thread.reverted makes the client drop all activities from
    // discarded turns; each surviving turn must keep a usable row.
    const olderTurn = makeContextWindowActivity("ctx-old", 1_500, "turn-kept");
    const revertedTurn = makeContextWindowActivity("ctx-new", 9_000, "turn-reverted");

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([olderTurn, revertedTurn]),
    });
    const afterRevert = projected.thread.activities.filter(
      (row) => row.turnId === TurnId.make("turn-kept"),
    );

    expect(afterRevert.map((row) => row.id)).toEqual([olderTurn.id]);
  });

  it("does not let a malformed row shadow an earlier valid row in the same turn", () => {
    const valid = makeContextWindowActivity("ctx-valid", 5_000, "turn-a");
    const malformed: OrchestrationThreadActivity = {
      ...makeContextWindowActivity("ctx-broken", 0, "turn-a"),
      payload: { usedTokens: null },
    };

    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([valid, malformed]),
    });

    // The malformed row passes through and the valid row survives, so the
    // client's backward walk still resolves the same value as full history.
    expect(projected.thread.activities.map((row) => row.id)).toEqual([valid.id, malformed.id]);
  });

  it("leaves snapshots without context-window activities untouched", () => {
    const tool = activity("tool-only", "command_execution", {
      item: { command: ["bash", "-lc", "true"] },
    });
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 7,
      thread: makeThread([tool]),
    });
    expect(projected.thread.activities.map((row) => row.id)).toEqual([tool.id]);
  });

  it("does not filter live activity-appended events", () => {
    const row = makeContextWindowActivity("ctx-live", 4_000);
    const event = {
      sequence: 9,
      eventId: EventId.make("event-ctx"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-projection"),
      occurredAt: "2026-07-27T00:00:02.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.make("thread-projection"),
        activity: row,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    const projected = projectActivityEvent(event);
    expect(
      projected.type === "thread.activity-appended" ? projected.payload.activity : undefined,
    ).toEqual(row);
  });
});
