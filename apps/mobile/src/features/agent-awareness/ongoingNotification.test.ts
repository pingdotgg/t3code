import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Notifications from "expo-notifications";

import {
  buildOngoingAgentNotificationContent,
  ongoingAgentNotificationTrigger,
  ongoingNotificationBodyPassesSec032,
  ONGOING_AGENT_NOTIFICATION_TAG,
  shouldShowOngoingAgentNotification,
} from "./ongoingNotificationModel";
import {
  resetOngoingAgentNotificationSyncForTests,
  syncOngoingAgentNotification,
} from "./ongoingNotificationSync";
const platformState = vi.hoisted(() => ({
  OS: "android" as "ios" | "android" | "web",
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return platformState.OS;
    },
  },
}));

vi.mock("expo-notifications", () => ({
  AndroidNotificationPriority: {
    LOW: -1,
  },
  setNotificationHandler: vi.fn(),
  scheduleNotificationAsync: vi.fn(() => Promise.resolve("t3-agent-aggregate")),
  dismissNotificationAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("./notificationChannels", () => ({
  AGENT_NOTIFICATION_CHANNEL_IDS: {
    running: "agent_running",
  },
  ensureAgentNotificationChannels: vi.fn(() => Promise.resolve()),
}));

const aggregate: RelayAgentActivityAggregateState = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 2,
  updatedAt: "2026-06-29T11:00:00.000Z",
  activities: [
    {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-approval"),
      projectTitle: "T3 Code",
      threadTitle: "Approval thread",
      modelTitle: "gpt-5.4",
      phase: "waiting_for_approval",
      status: "Approval",
      updatedAt: "2026-06-29T11:00:00.000Z",
      deepLink: "/threads/environment-1/thread-approval",
    },
    {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-running"),
      projectTitle: "T3 Code",
      threadTitle: "Running thread",
      modelTitle: "gpt-5.4",
      phase: "running",
      status: "Working",
      updatedAt: "2026-06-29T10:00:00.000Z",
      deepLink: "/threads/environment-1/thread-running",
    },
  ],
};

describe("ongoing notification model", () => {
  it("shows ongoing notification only for running or approval primaries", () => {
    expect(shouldShowOngoingAgentNotification(aggregate)).toBe(true);
    expect(
      shouldShowOngoingAgentNotification({
        ...aggregate,
        activities: [
          {
            ...aggregate.activities[0]!,
            phase: "waiting_for_input",
            status: "Input",
          },
        ],
      }),
    ).toBe(false);
    expect(shouldShowOngoingAgentNotification(null)).toBe(false);
  });

  it("builds sticky low-priority Android content with SEC-032-safe body", () => {
    const content = buildOngoingAgentNotificationContent(aggregate);
    expect(content.sticky).toBe(true);
    expect(content.sound).toBe(false);
    expect(content.priority).toBe(-1);
    expect(content.data).toEqual({
      deepLink: "/threads/environment-1/thread-approval",
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-approval"),
      notificationTag: ONGOING_AGENT_NOTIFICATION_TAG,
      phase: "waiting_for_approval",
    });
    expect(content.body).toContain("Approval thread");
    expect(content.body).not.toContain("stdout");
    expect(ongoingNotificationBodyPassesSec032(content.body ?? "")).toBe(true);
  });
});

describe("syncOngoingAgentNotification", () => {
  beforeEach(() => {
    platformState.OS = "android";
    resetOngoingAgentNotificationSyncForTests();
    vi.mocked(Notifications.scheduleNotificationAsync).mockClear();
    vi.mocked(Notifications.dismissNotificationAsync).mockClear();
    vi.mocked(Notifications.setNotificationHandler).mockClear();
  });

  it("updates the same identifier in place for aggregate ticks", async () => {
    await syncOngoingAgentNotification({
      aggregate,
      notificationsEnabled: true,
    });
    await syncOngoingAgentNotification({
      aggregate,
      notificationsEnabled: true,
    });

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: ONGOING_AGENT_NOTIFICATION_TAG,
      content: expect.objectContaining({
        sticky: true,
      }),
      trigger: ongoingAgentNotificationTrigger(),
    });
  });

  it("dismisses ongoing notification when active work is no longer eligible", async () => {
    await syncOngoingAgentNotification({
      aggregate,
      notificationsEnabled: true,
    });
    await syncOngoingAgentNotification({
      aggregate: {
        ...aggregate,
        activeCount: 0,
        activities: [],
      },
      notificationsEnabled: true,
    });

    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith(
      ONGOING_AGENT_NOTIFICATION_TAG,
    );
  });

  it("skips Android notification work on non-Android platforms", async () => {
    platformState.OS = "ios";
    await syncOngoingAgentNotification({
      aggregate,
      notificationsEnabled: true,
    });
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it("clears ongoing notification when notifications are disabled", async () => {
    await syncOngoingAgentNotification({
      aggregate,
      notificationsEnabled: true,
    });
    vi.mocked(Notifications.dismissNotificationAsync).mockClear();
    await syncOngoingAgentNotification({
      aggregate,
      notificationsEnabled: false,
    });
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith(
      ONGOING_AGENT_NOTIFICATION_TAG,
    );
  });
});
