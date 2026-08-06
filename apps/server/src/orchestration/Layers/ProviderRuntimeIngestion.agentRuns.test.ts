import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const base = {
  provider: ProviderDriverKind.make("claudeAgent"),
  createdAt: "2026-07-18T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
} as const;

function payloadOf(event: ProviderRuntimeEvent): Record<string, unknown> {
  const [activity] = runtimeEventToActivities(event);
  return (activity?.payload ?? {}) as Record<string, unknown>;
}

describe("runtimeEventToActivities agent-run fields", () => {
  it("puts task.started enrichment at the top level of payload, never under data", () => {
    const payload = payloadOf({
      ...base,
      type: "task.started",
      eventId: EventId.make("evt-task-started"),
      payload: {
        taskId: RuntimeTaskId.make("task-1"),
        description: "Review the migration",
        taskType: "local_workflow",
        toolUseId: "toolu_1",
        subagentType: "code-reviewer",
        workflowName: "spec",
        prompt: "Please review the migration edge cases.",
        ambient: true,
      },
    } satisfies ProviderRuntimeEvent);

    expect(payload.toolUseId).toBe("toolu_1");
    expect(payload.subagentType).toBe("code-reviewer");
    expect(payload.workflowName).toBe("spec");
    expect(payload.prompt).toBe("Please review the migration edge cases.");
    expect(payload.ambient).toBe(true);
    expect(payload.data).toBeUndefined();
  });

  it("omits absent task.started enrichment while retaining the derived classification", () => {
    const payload = payloadOf({
      ...base,
      type: "task.started",
      eventId: EventId.make("evt-task-started-plain"),
      payload: {
        taskId: RuntimeTaskId.make("task-2"),
        description: "Plain task",
      },
    } satisfies ProviderRuntimeEvent);

    expect(Object.keys(payload).toSorted()).toEqual(["agentKind", "detail", "taskId"]);
    expect(payload.agentKind).toBe("agent");
  });

  it("puts task.progress metrics at the top level of payload", () => {
    const payload = payloadOf({
      ...base,
      type: "task.progress",
      eventId: EventId.make("evt-task-progress"),
      payload: {
        taskId: RuntimeTaskId.make("task-1"),
        description: "Running background teammate",
        toolUseId: "toolu_2",
        subagentType: "code-reviewer",
        totalTokens: 123,
        toolUses: 4,
        durationMs: 987,
      },
    } satisfies ProviderRuntimeEvent);

    expect(payload.toolUseId).toBe("toolu_2");
    expect(payload.subagentType).toBe("code-reviewer");
    expect(payload.totalTokens).toBe(123);
    expect(payload.toolUses).toBe(4);
    expect(payload.durationMs).toBe(987);
    expect(payload.data).toBeUndefined();
  });

  it("puts the task.completed failure reason at the top level of payload", () => {
    const [activity] = runtimeEventToActivities({
      ...base,
      type: "task.completed",
      eventId: EventId.make("evt-task-completed"),
      payload: {
        taskId: RuntimeTaskId.make("task-1"),
        status: "failed",
        error: "Subagent exceeded its budget",
        totalTokens: 12,
        toolUses: 1,
        durationMs: 900,
      },
    } satisfies ProviderRuntimeEvent);

    const payload = (activity?.payload ?? {}) as Record<string, unknown>;
    expect(activity?.tone).toBe("error");
    expect(payload.error).toBe("Subagent exceeded its budget");
    expect(payload.totalTokens).toBe(12);
    expect(payload.toolUses).toBe(1);
    expect(payload.durationMs).toBe(900);
    expect(payload.data).toBeUndefined();
  });
});
