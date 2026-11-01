import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AgentActivityProps } from "../../widgets/AgentActivity";

const native = vi.hoisted(() => ({
  activities: [] as Array<{ end: () => Promise<void> }>,
  started: [] as Array<string>,
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({
  requestPermissionsAsync: async () => ({ granted: true, status: "granted" }),
  dismissAllNotificationsAsync: async () => {},
}));
vi.mock("../agent-awareness/androidNotifications", () => ({
  showAndroidShowcaseAgentActivity: () => true,
}));
vi.mock("../agent-awareness/agentLiveActivity", () => ({
  getAgentLiveActivities: () => [...native.activities],
  startAgentLiveActivity: (props: AgentActivityProps) => {
    const activity = { end: async () => {} };
    native.started.push(props.title);
    native.activities = [activity];
    return activity;
  },
}));

const { stageShowcaseAgentActivity } = await import("./stageShowcaseAgentActivity");

function fixture(title: string): AgentActivityProps {
  return {
    title,
    subtitle: "Agent work in progress",
    activeCount: 1,
    updatedAt: "2026-10-31T17:42:00.000Z",
    activities: [],
  };
}

describe("stageShowcaseAgentActivity", () => {
  beforeEach(() => {
    native.activities = [];
    native.started = [];
  });

  it("does not start a replaced fixture after its native end call settles", async () => {
    let finishEnding = () => {};
    const ending = new Promise<void>((resolve) => (finishEnding = resolve));
    let endCalls = 0;
    native.activities = [{ end: () => (endCalls++ === 0 ? ending : Promise.resolve()) }];
    let replaced = false;

    const first = stageShowcaseAgentActivity(fixture("store"), 0, () => replaced);
    await vi.waitFor(() => expect(endCalls).toBe(1));
    replaced = true;
    const second = await stageShowcaseAgentActivity(fixture("handoff-approval"), 0, () => false);
    finishEnding();

    expect(second).toBe(true);
    expect(await first).not.toBe(true);
    expect(native.started).toEqual(["handoff-approval"]);
  });
});
