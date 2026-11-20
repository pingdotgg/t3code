import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { describe, expect, it } from "vite-plus/test";
import { aggregateActivity, liveActivityPayload } from "./payloads.ts";

const now = "2026-09-06T18:10:00.000Z";
const state: AgentAwarenessState = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Deploy staging",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Agent is working",
  updatedAt: "2026-09-06T18:00:00.000Z",
  deepLink: "/threads/environment/thread",
};

describe("direct activity summaries", () => {
  it("carries recent failure context without counting it as active work or retaining old errors", () => {
    const summary = aggregateActivity(
      [
        state,
        {
          ...state,
          threadId: ThreadId.make("recent"),
          phase: "failed",
          detail: "Credential expired\nInternal stack trace",
        },
        {
          ...state,
          threadId: ThreadId.make("old"),
          phase: "failed",
          updatedAt: "2026-09-05T18:00:00.000Z",
        },
      ],
      now,
    );
    expect(summary.activeCount).toBe(1);
    expect(summary.activities.map((row) => row.threadId)).toEqual(["thread", "recent"]);
    expect(summary.activities[1]?.detail).toBe("Credential expired");
  });

  it("sends Live Activity props in the AgentActivity layout's shape", () => {
    const summary = aggregateActivity(
      [{ ...state, projectId: "project", turnId: "turn", summary: "Deployed", detail: "Note" }],
      now,
    );
    const payload = liveActivityPayload(
      summary,
      100,
      false,
      "DirectAgentActivity:environment",
      "t3code-dev",
    );
    expect(JSON.parse(payload.aps["content-state"].props)).toEqual({
      appScheme: "t3code-dev",
      title: summary.title,
      subtitle: summary.subtitle,
      activeCount: 1,
      updatedAt: now,
      activities: [
        {
          environmentId: "environment",
          threadId: "thread",
          projectTitle: "Project",
          threadTitle: "Deploy staging",
          modelTitle: "gpt-5.4",
          phase: "running",
          status: "Agent is working",
          updatedAt: "2026-09-06T18:00:00.000Z",
          deepLink: "/threads/environment/thread",
        },
      ],
    });
  });

  it("keeps the final result when ending an activity and bounds multi-byte payloads", () => {
    const summary = aggregateActivity([{ ...state, phase: "completed" }], now);
    expect(summary.activeCount).toBe(0);
    expect(summary.activities[0]?.phase).toBe("completed");
    const payload = liveActivityPayload(
      {
        ...summary,
        activities: Array.from({ length: 3 }, () => ({
          ...summary.activities[0]!,
          threadTitle: "大".repeat(60),
          projectTitle: "大".repeat(60),
          modelTitle: "大".repeat(60),
          detail: "大".repeat(140),
        })),
      },
      100,
      true,
    );
    expect(payload.aps.event).toBe("end");
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(4096);
  });
});
