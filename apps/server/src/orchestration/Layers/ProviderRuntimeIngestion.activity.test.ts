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

describe("runtimeEventToActivities usage limits", () => {
  it("normalizes a Claude rate_limit_event into a usage-limits activity", () => {
    const activities = runtimeEventToActivities({
      ...base,
      provider: ProviderDriverKind.make("claudeAgent"),
      type: "account.rate-limits.updated",
      eventId: EventId.make("evt-claude-limits"),
      payload: {
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.82,
            resetsAt: 1_785_000_000,
            overageStatus: "allowed",
            isUsingOverage: false,
          },
          uuid: "uuid-1",
          session_id: "session-1",
        },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      kind: "usage-limits.updated",
      tone: "info",
      summary: "Usage limits updated",
      payload: {
        provider: "claudeAgent",
        status: "warning",
        windows: [
          {
            id: "five_hour",
            usedPercent: 82,
            resetsAt: "2026-07-25T17:20:00.000Z",
            windowDurationMins: 300,
          },
        ],
        overage: { status: "ok", inUse: false, resetsAt: null, disabledReason: null },
      },
    });
  });

  it("normalizes a Codex rate limit snapshot with both windows and plan context", () => {
    const activities = runtimeEventToActivities({
      ...base,
      type: "account.rate-limits.updated",
      eventId: EventId.make("evt-codex-limits"),
      payload: {
        rateLimits: {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 12, resetsAt: 1_785_000_000, windowDurationMins: 300 },
            secondary: { usedPercent: 47, resetsAt: 1_785_400_000, windowDurationMins: 10_080 },
            credits: { hasCredits: true, unlimited: false, balance: "12.50" },
            rateLimitReachedType: null,
            spendControlReached: false,
          },
        },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toHaveLength(1);
    expect(activities[0]?.payload).toEqual({
      provider: "codex",
      status: "ok",
      windows: [
        {
          id: "primary",
          usedPercent: 12,
          resetsAt: "2026-07-25T17:20:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "secondary",
          usedPercent: 47,
          resetsAt: "2026-07-30T08:26:40.000Z",
          windowDurationMins: 10_080,
        },
      ],
      planType: "plus",
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    });
  });

  it("marks Codex snapshots limited when a limit has been reached", () => {
    const activities = runtimeEventToActivities({
      ...base,
      type: "account.rate-limits.updated",
      eventId: EventId.make("evt-codex-limited"),
      payload: {
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 100, resetsAt: null, windowDurationMins: 300 },
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activities[0]?.payload).toMatchObject({
      status: "limited",
      limitReason: "rate_limit_reached",
      windows: [{ id: "primary", usedPercent: 100, resetsAt: null }],
    });
  });

  it("drops rate limit events that carry nothing to display", () => {
    const activities = runtimeEventToActivities({
      ...base,
      type: "account.rate-limits.updated",
      eventId: EventId.make("evt-empty-limits"),
      payload: { rateLimits: { rateLimits: {} } },
    } satisfies ProviderRuntimeEvent);

    expect(activities).toEqual([]);
  });
});
