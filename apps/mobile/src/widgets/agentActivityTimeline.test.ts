import { describe, expect, it } from "vite-plus/test";
import type {
  AgentActivityPhase,
  AgentActivityProps,
  AgentActivityRowProps,
} from "./AgentActivity";
import { agentActivityTimeline, AGENT_ACTIVITY_FRESHNESS_MS } from "./agentActivityTimeline";

const now = Date.parse("2026-10-02T12:00:00.000Z");
const row = {
  environmentId: "environment-1",
  threadId: "thread-1",
  projectTitle: "Project",
  threadTitle: "Task",
  modelTitle: "Codex",
  phase: "running",
  status: "Working",
  updatedAt: new Date(now).toISOString(),
  deepLink: "/threads/environment-1/thread-1",
} satisfies AgentActivityRowProps;
const props = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: new Date(now).toISOString(),
  activities: [row],
  expiresAt: now + AGENT_ACTIVITY_FRESHNESS_MS,
} satisfies AgentActivityProps;

describe("agentActivityTimeline", () => {
  it("schedules expiration without requiring the app to run again", () => {
    const timeline = agentActivityTimeline(props, now);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([now, props.expiresAt]);
    expect(timeline[0]?.props).toEqual(props);
    expect(timeline[1]?.props).toEqual({
      ...props,
      activeCount: -1,
      isExpired: true,
      subtitle: "Open T3 to refresh",
      activities: [{ ...row, phase: "stale", status: "Out of date" }],
    });
  });

  it.each([
    "starting",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "stale",
  ] satisfies AgentActivityPhase[])("expires unfinished %s work", (phase) => {
    const timeline = agentActivityTimeline({ ...props, activities: [{ ...row, phase }] }, now);
    expect(timeline[1]?.props.activities[0]).toMatchObject({
      phase: "stale",
      status: "Out of date",
    });
  });

  it("keeps terminal outcomes and row links when other work expires", () => {
    const completed = {
      ...row,
      threadId: "completed",
      phase: "completed",
      status: "Done",
    } as const;
    const failed = { ...row, threadId: "failed", phase: "failed", status: "Failed" } as const;
    const timeline = agentActivityTimeline({ ...props, activities: [row, completed, failed] }, now);
    expect(timeline[1]?.props.activities.slice(1)).toEqual([completed, failed]);
    expect(timeline[1]?.props.activities[0]?.deepLink).toBe(row.deepLink);
  });

  it("publishes an already old observation as expired immediately", () => {
    const timeline = agentActivityTimeline(props, props.expiresAt);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.props).toMatchObject({ activeCount: -1, isExpired: true });
  });

  it("preserves the disconnected distinction until its original deadline", () => {
    const timeline = agentActivityTimeline({ ...props, isStale: true }, now);
    expect(timeline[0]?.props).toMatchObject({ isStale: true, activeCount: 1 });
    expect(timeline[1]?.props).toMatchObject({ isStale: true, isExpired: true, activeCount: -1 });
  });

  it("encodes unavailable counts without nulls rejected by native widget storage", () => {
    const timeline = agentActivityTimeline({ ...props, activeCount: null }, now);
    expect(timeline.map((entry) => entry.props.activeCount)).toEqual([-1, -1]);
    expect(JSON.stringify(timeline)).not.toContain(":null");
  });

  it("does not schedule signed-out idle content to expire", () => {
    const idle = { ...props, expiresAt: undefined, activeCount: 0, activities: [] };
    expect(agentActivityTimeline(idle, now)).toEqual([{ date: new Date(now), props: idle }]);
  });
});
