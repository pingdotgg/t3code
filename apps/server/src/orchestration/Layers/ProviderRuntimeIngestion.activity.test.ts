import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeBackgroundIngestion, runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

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

describe("mergeBackgroundIngestion", () => {
  it("preserves usage when a later task progress tick only updates activity", () => {
    const taskId = RuntimeTaskId.make("agent-partial-progress");
    const usageUpdate = {
      source: "runtime",
      event: {
        ...base,
        type: "task.progress",
        eventId: EventId.make("evt-task-usage"),
        payload: {
          taskId,
          description: "Agent partial progress",
          typedUsage: { totalTokens: 4_200 },
        },
      } satisfies ProviderRuntimeEvent,
    } as const;
    const activityUpdate = {
      source: "runtime",
      event: {
        ...base,
        type: "task.progress",
        eventId: EventId.make("evt-task-activity"),
        payload: {
          taskId,
          description: "Agent partial progress",
          summary: "Running tests",
          lastToolName: "exec_command",
        },
      } satisfies ProviderRuntimeEvent,
    } as const;

    const merged = mergeBackgroundIngestion([usageUpdate], [activityUpdate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event.type).toBe("task.progress");
    if (merged[0]?.event.type === "task.progress") {
      expect(merged[0].event.payload).toEqual({
        taskId,
        description: "Agent partial progress",
        typedUsage: { totalTokens: 4_200 },
        summary: "Running tests",
        lastToolName: "exec_command",
      });
    }
  });

  it("preserves activity and max-merges a later sparse usage update", () => {
    const taskId = RuntimeTaskId.make("agent-later-usage");
    const activityUpdate = {
      source: "runtime",
      event: {
        ...base,
        type: "task.progress",
        eventId: EventId.make("evt-earlier-activity"),
        payload: {
          taskId,
          description: "Agent later usage",
          summary: "Running tests",
          lastToolName: "exec_command",
          typedUsage: {
            totalTokens: 100,
            inputTokens: 80,
            cachedInputTokens: 30,
            outputTokens: 20,
            reasoningOutputTokens: 10,
            toolUses: 3,
            durationMs: 1_000,
          },
        },
      } satisfies ProviderRuntimeEvent,
    } as const;
    const usageUpdate = {
      source: "runtime",
      event: {
        ...base,
        type: "task.progress",
        eventId: EventId.make("evt-later-usage"),
        payload: {
          taskId,
          description: "Agent later usage",
          typedUsage: {
            totalTokens: 200,
            inputTokens: 70,
            outputTokens: 40,
            durationMs: 900,
          },
        },
      } satisfies ProviderRuntimeEvent,
    } as const;

    const merged = mergeBackgroundIngestion([activityUpdate], [usageUpdate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event.type).toBe("task.progress");
    if (merged[0]?.event.type === "task.progress") {
      expect(merged[0].event.payload).toEqual({
        taskId,
        description: "Agent later usage",
        summary: "Running tests",
        lastToolName: "exec_command",
        typedUsage: {
          totalTokens: 200,
          inputTokens: 80,
          cachedInputTokens: 30,
          outputTokens: 40,
          reasoningOutputTokens: 10,
          toolUses: 3,
          durationMs: 1_000,
        },
      });
    }
  });

  it("replaces stale activity fields while preserving the last usage snapshot", () => {
    const taskId = RuntimeTaskId.make("agent-replaced-progress");
    const previous = {
      source: "runtime",
      event: {
        ...base,
        type: "task.progress",
        eventId: EventId.make("evt-previous-progress"),
        payload: {
          taskId,
          description: "Agent replaced progress",
          summary: "Old summary",
          lastToolName: "old_tool",
          error: "Old error",
          phases: [{ index: 0, title: "Old phase" }],
          typedUsage: { totalTokens: 4_200 },
        },
      } satisfies ProviderRuntimeEvent,
    } as const;
    const next = {
      source: "runtime",
      event: {
        ...base,
        type: "task.progress",
        eventId: EventId.make("evt-next-progress"),
        payload: {
          taskId,
          description: "Agent replaced progress",
          phases: [{ index: 1, title: "New phase" }],
          typedUsage: { totalTokens: 5_000 },
        },
      } satisfies ProviderRuntimeEvent,
    } as const;

    const merged = mergeBackgroundIngestion([previous], [next]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event.type).toBe("task.progress");
    if (merged[0]?.event.type === "task.progress") {
      expect(merged[0].event.payload).toEqual({
        taskId,
        description: "Agent replaced progress",
        phases: [{ index: 1, title: "New phase" }],
        typedUsage: { totalTokens: 5_000 },
      });
    }
  });

  it("preserves explicit task reactivation order", () => {
    const taskId = RuntimeTaskId.make("agent-reactivated");
    const completed = {
      source: "runtime",
      event: {
        ...base,
        type: "task.completed",
        eventId: EventId.make("evt-task-completed"),
        payload: { taskId, status: "completed" },
      } satisfies ProviderRuntimeEvent,
    } as const;
    const reactivated = {
      source: "runtime",
      event: {
        ...base,
        type: "task.updated",
        eventId: EventId.make("evt-task-reactivated"),
        payload: { taskId, status: "running" },
      } satisfies ProviderRuntimeEvent,
    } as const;

    const merged = mergeBackgroundIngestion([completed], [reactivated]);

    expect(merged.map((input) => input.event.type)).toEqual(["task.completed", "task.updated"]);
  });

  it("preserves fields from partial task status patches", () => {
    const taskId = RuntimeTaskId.make("agent-partial-update");
    const statusUpdate = {
      source: "runtime",
      event: {
        ...base,
        type: "task.updated",
        eventId: EventId.make("evt-task-status"),
        payload: {
          taskId,
          status: "completed",
        },
      } satisfies ProviderRuntimeEvent,
    } as const;
    const completionTimeUpdate = {
      source: "runtime",
      event: {
        ...base,
        type: "task.updated",
        eventId: EventId.make("evt-task-ended-at"),
        payload: {
          taskId,
          endedAt: "2026-08-06T00:00:01.000Z",
        },
      } satisfies ProviderRuntimeEvent,
    } as const;

    const merged = mergeBackgroundIngestion([statusUpdate], [completionTimeUpdate]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event.type).toBe("task.updated");
    if (merged[0]?.event.type === "task.updated") {
      expect(merged[0].event.payload).toEqual({
        taskId,
        status: "completed",
        endedAt: "2026-08-06T00:00:01.000Z",
      });
    }
  });
});
