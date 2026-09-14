import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};

describe("runtimeEventToActivities task progress", () => {
  it("persists usage independently from replaceable activity", () => {
    const taskId = RuntimeTaskId.make("agent-1");
    const usageOnly = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-usage"),
      payload: {
        taskId,
        description: "Agent one",
        typedUsage: { totalTokens: 73_700_000 },
      },
    } satisfies ProviderRuntimeEvent;
    const command = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-command"),
      payload: {
        taskId,
        description: "Agent one",
        summary: "Running tests",
        lastToolName: "exec_command",
      },
    } satisfies ProviderRuntimeEvent;

    const usageActivities = runtimeEventToActivities(usageOnly);
    const commandActivities = runtimeEventToActivities(command);

    expect(usageActivities.map((activity) => activity.id)).toEqual(["task-usage:thread-1:agent-1"]);
    expect(commandActivities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-1",
    ]);
    const usagePayload = usageActivities[0]?.payload as Record<string, unknown> | undefined;
    expect(usagePayload?.typedUsage).toEqual({ totalTokens: 73_700_000 });
    expect(usagePayload?.usageSnapshot).toBe(true);
  });

  it("splits combined progress and usage into their independent snapshots", () => {
    const event = {
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-combined"),
      payload: {
        taskId: RuntimeTaskId.make("agent-2"),
        description: "Agent two",
        summary: "Inspecting the panel",
        typedUsage: { totalTokens: 4_200, toolUses: 7 },
        status: "running",
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);
    const progressPayload = activities[0]?.payload as Record<string, unknown>;
    const usagePayload = activities[1]?.payload as Record<string, unknown>;

    expect(activities.map((activity) => activity.id)).toEqual([
      "task-progress:thread-1:agent-2",
      "task-usage:thread-1:agent-2",
    ]);
    expect(progressPayload.summary).toBe("Inspecting the panel");
    expect(progressPayload.status).toBe("running");
    expect(progressPayload).not.toHaveProperty("typedUsage");
    expect(usagePayload.typedUsage).toEqual({ totalTokens: 4_200, toolUses: 7 });
    expect(usagePayload.usageSnapshot).toBe(true);
    expect(usagePayload).not.toHaveProperty("status");
  });
});
describe("runtimeEventToActivities tool streaming persistence", () => {
  const accumulatedStdout = [
    "first line of output",
    ...Array.from({ length: 500 }, (_, index) => `Capturing frame ${index}/9028`),
  ].join("\n");
  const streamingData = {
    toolCallId: "tool-call-1",
    kind: "execute",
    command: "blender --render",
    rawOutput: { stdout: accumulatedStdout },
    content: [{ type: "content", content: { type: "text", text: accumulatedStdout } }],
  };

  it("persists tool.updated with the wire projection of data, not the accumulated stream", () => {
    const event = {
      ...base,
      type: "item.updated",
      eventId: EventId.make("evt-tool-streaming-updated"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Render",
        detail: accumulatedStdout,
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    expect(payload.status).toBe("inProgress");
    expect(data.toolCallId).toBe("tool-call-1");
    expect(data.command).toBe("blender --render");
    expect(data.rawOutput).toEqual({ content: "first line of output" });
    expect(data.content).toBeUndefined();
    expect(JSON.stringify(data).length).toBeLessThan(1_000);
  });

  it("persists the full terminal payload on tool.completed", () => {
    const event = {
      ...base,
      type: "item.completed",
      eventId: EventId.make("evt-tool-streaming-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Render",
        data: streamingData,
      },
    } satisfies ProviderRuntimeEvent;

    const activities = runtimeEventToActivities(event);

    expect(activities).toHaveLength(1);
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.data).toEqual(streamingData);
  });
});

describe("runtimeEventToActivities reasoning lifecycle", () => {
  const reasoningUpdated = {
    ...base,
    provider: ProviderDriverKind.make("opencode"),
    type: "item.updated",
    eventId: EventId.make("evt-reasoning-updated"),
    itemId: RuntimeItemId.make("reasoning-part-1"),
    createdAt: "2026-08-06T00:00:01.000Z",
    payload: {
      itemType: "reasoning",
      status: "inProgress",
      title: "Thinking",
    },
  } satisfies ProviderRuntimeEvent;

  it("projects reasoning updates as thinking tool activity without text", () => {
    const activities = runtimeEventToActivities(reasoningUpdated);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      tone: "tool",
      kind: "tool.updated",
      summary: "Thinking",
    });
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.itemType).toBe("reasoning");
    expect(payload.toolCallId).toBe("reasoning-part-1");
    expect(payload.status).toBe("inProgress");
    expect(payload.title).toBe("Thinking");
    expect(payload).not.toHaveProperty("detail");
  });

  it("preserves provider reasoning text on lifecycle detail without truncating it", () => {
    const longDetail = `${"The user wants to know their opencode version. ".repeat(8)}I should run the command.`;
    expect(longDetail.length).toBeGreaterThan(180);

    const updated = runtimeEventToActivities({
      ...reasoningUpdated,
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Thinking",
        detail: longDetail,
      },
    });
    expect(updated[0]?.payload).toMatchObject({
      itemType: "reasoning",
      detail: longDetail,
    });

    const completed = runtimeEventToActivities({
      ...reasoningUpdated,
      type: "item.completed",
      eventId: EventId.make("evt-reasoning-completed-text"),
      createdAt: "2026-08-06T00:00:05.000Z",
      payload: {
        itemType: "reasoning",
        status: "completed",
        title: "Thinking",
        detail: longDetail,
      },
    });
    expect(completed[0]?.payload).toMatchObject({
      itemType: "reasoning",
      status: "completed",
      detail: longDetail,
    });
  });

  it("projects reasoning completions with terminal status", () => {
    const activities = runtimeEventToActivities({
      ...reasoningUpdated,
      type: "item.completed",
      eventId: EventId.make("evt-reasoning-completed"),
      createdAt: "2026-08-06T00:00:05.000Z",
      payload: { itemType: "reasoning", status: "completed", title: "Thinking" },
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      tone: "tool",
      kind: "tool.completed",
      summary: "Thinking",
      createdAt: "2026-08-06T00:00:05.000Z",
    });
    const payload = activities[0]?.payload as Record<string, unknown>;
    expect(payload.itemType).toBe("reasoning");
    expect(payload.toolCallId).toBe("reasoning-part-1");
    expect(payload.status).toBe("completed");
    expect(payload).not.toHaveProperty("detail");
  });

  it("still drops reasoning starts and unrelated item types", () => {
    expect(
      runtimeEventToActivities({
        ...reasoningUpdated,
        type: "item.started",
        eventId: EventId.make("evt-reasoning-started"),
      }),
    ).toEqual([]);
    for (const itemType of ["plan", "assistant_message", "unknown"] as const) {
      expect(
        runtimeEventToActivities({
          ...reasoningUpdated,
          type: "item.completed",
          eventId: EventId.make(`evt-other-${itemType}`),
          payload: { itemType, status: "completed", title: "Other" },
        }),
      ).toEqual([]);
    }
  });

  it("drops status-less Codex-style reasoning updates so timelines stay unchanged", () => {
    // Codex summaryPartAdded emits itemType reasoning without lifecycle status.
    expect(
      runtimeEventToActivities({
        ...reasoningUpdated,
        provider: ProviderDriverKind.make("codex"),
        eventId: EventId.make("evt-codex-reasoning"),
        payload: {
          itemType: "reasoning",
          data: { text: "summary part" },
        },
      }),
    ).toEqual([]);
    expect(
      runtimeEventToActivities({
        ...reasoningUpdated,
        provider: ProviderDriverKind.make("codex"),
        type: "item.completed",
        eventId: EventId.make("evt-codex-reasoning-completed"),
        payload: {
          itemType: "reasoning",
          data: { text: "summary part" },
        },
      }),
    ).toEqual([]);
  });
});
