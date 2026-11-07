import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";

import {
  AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS,
  agentActivityWidgetTimeline,
} from "./agentActivityWidgetTimeline";
import { publishAgentActivityWidget } from "./publishAgentActivityWidget.ios";

const nativeWidget = vi.hoisted(() => ({ getTimeline: vi.fn(), updateTimeline: vi.fn() }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => ({}) }));
vi.mock("./AgentActivityWidget", () => ({ default: nativeWidget }));

const now = Date.parse("2026-10-18T10:00:00.000Z");

type Row = RelayAgentActivityAggregateState["activities"][number];

function row(phase: Row["phase"], status: string): Row {
  return {
    environmentId: "env-1" as EnvironmentId,
    threadId: `thread-${phase}` as ThreadId,
    projectTitle: "t3code",
    threadTitle: `Thread ${phase}`,
    modelTitle: "GPT-5.5",
    phase,
    status,
    updatedAt: "2026-10-18T09:59:00.000Z",
    deepLink: `/threads/env-1/thread-${phase}`,
  };
}

function aggregate(activities: ReadonlyArray<Row>): RelayAgentActivityAggregateState {
  return {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activities.length,
    updatedAt: "2026-10-18T09:59:00.000Z",
    activities,
  };
}

describe("agentActivityWidgetTimeline", () => {
  it("persists the snapshot owner and clears rows on sign-out", async () => {
    nativeWidget.updateTimeline.mockClear();
    await publishAgentActivityWidget(
      { kind: "snapshot", aggregate: aggregate([row("running", "Working")]) },
      "user-a",
    );
    expect(nativeWidget.updateTimeline).toHaveBeenLastCalledWith([
      expect.objectContaining({ props: expect.objectContaining({ accountId: "user-a" }) }),
      expect.objectContaining({ props: expect.objectContaining({ accountId: "user-a" }) }),
    ]);

    await publishAgentActivityWidget({ kind: "signed-out" }, null);
    expect(nativeWidget.updateTimeline).toHaveBeenLastCalledWith([
      expect.objectContaining({
        props: expect.objectContaining({ activities: [] }),
      }),
    ]);
    expect(nativeWidget.updateTimeline.mock.lastCall?.[0][0].props).not.toHaveProperty("accountId");
  });

  it("keeps sign-out last when an earlier cached timeline read is delayed", async () => {
    let release = (_entries: unknown[]) => {};
    let requested = () => {};
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    nativeWidget.getTimeline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          requested();
        }),
    );
    nativeWidget.updateTimeline.mockClear();

    const loading = publishAgentActivityWidget({ kind: "loading" }, "user-a");
    await started;
    const signOut = publishAgentActivityWidget({ kind: "signed-out" }, null);
    release([]);
    await Promise.all([loading, signOut]);

    expect(nativeWidget.updateTimeline).toHaveBeenLastCalledWith([
      expect.objectContaining({
        props: expect.objectContaining({
          subtitle: "Sign in to T3 Connect to see agents",
          activities: [],
        }),
      }),
    ]);
  });

  it("keeps persisted account rows and their stale deadline after a cold-start read failure", async () => {
    const cached = agentActivityWidgetTimeline(
      { kind: "snapshot", aggregate: aggregate([row("running", "Working")]) },
      now,
    ).map((entry) => ({ ...entry, props: { ...entry.props, accountId: "user-a" } }));
    nativeWidget.getTimeline.mockResolvedValue(cached);
    nativeWidget.updateTimeline.mockClear();

    await publishAgentActivityWidget({ kind: "loading" }, "user-a");
    await publishAgentActivityWidget({ kind: "unavailable" }, "user-a");

    expect(nativeWidget.updateTimeline).not.toHaveBeenCalled();
  });

  it("replaces another account's persisted rows before its first relay read", async () => {
    nativeWidget.getTimeline.mockResolvedValue(
      agentActivityWidgetTimeline(
        { kind: "snapshot", aggregate: aggregate([row("running", "Working")]) },
        now,
      ).map((entry) => ({ ...entry, props: { ...entry.props, accountId: "user-a" } })),
    );
    nativeWidget.updateTimeline.mockClear();

    await publishAgentActivityWidget({ kind: "loading" }, "user-b");

    expect(nativeWidget.updateTimeline).toHaveBeenLastCalledWith([
      expect.objectContaining({
        props: expect.objectContaining({ subtitle: "Loading agents…", activities: [] }),
      }),
    ]);
  });

  it("replaces persisted placeholders after a failed relay read", async () => {
    nativeWidget.getTimeline.mockResolvedValue(
      agentActivityWidgetTimeline({ kind: "signed-out" }, now),
    );
    nativeWidget.updateTimeline.mockClear();

    await publishAgentActivityWidget({ kind: "unavailable" }, "user-a");

    expect(nativeWidget.updateTimeline).toHaveBeenLastCalledWith([
      expect.objectContaining({
        props: expect.objectContaining({ subtitle: "Couldn't reach T3 Connect", activities: [] }),
      }),
    ]);
  });

  it("marks unfinished rows out of date once the widget can no longer vouch for them", () => {
    const timeline = agentActivityWidgetTimeline(
      {
        kind: "snapshot",
        aggregate: aggregate([row("running", "Working"), row("completed", "Done")]),
      },
      now,
    );

    expect(timeline.map((entry) => entry.date.getTime())).toEqual([
      now,
      now + AGENT_ACTIVITY_WIDGET_STALE_AFTER_MS,
    ]);
    expect(timeline[0]?.props.activities.map((entry) => entry.phase)).toEqual([
      "running",
      "completed",
    ]);
    expect(timeline[1]?.props.activities.map((entry) => [entry.phase, entry.status])).toEqual([
      ["stale", "Out of date"],
      ["completed", "Done"],
    ]);
  });

  it("keeps finished outcomes on a single entry", () => {
    const timeline = agentActivityWidgetTimeline(
      { kind: "snapshot", aggregate: aggregate([row("failed", "Failed")]) },
      now,
    );

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.props.activities[0]?.phase).toBe("failed");
  });

  it("says no agents are active when the relay has no activity", () => {
    const [entry] = agentActivityWidgetTimeline({ kind: "snapshot", aggregate: null }, now);

    expect(entry?.props).toMatchObject({ subtitle: "No active agents", activities: [] });
  });

  it("asks the user to sign in instead of showing a previous account's agents", () => {
    const [entry] = agentActivityWidgetTimeline({ kind: "signed-out" }, now);

    expect(entry?.props).toMatchObject({
      subtitle: "Sign in to T3 Connect to see agents",
      activities: [],
    });
  });

  it("says T3 Connect is unreachable instead of asking a signed-in user to sign in", () => {
    const [entry] = agentActivityWidgetTimeline({ kind: "unavailable" }, now);

    expect(entry?.props).toMatchObject({ subtitle: "Couldn't reach T3 Connect", activities: [] });
  });
});
