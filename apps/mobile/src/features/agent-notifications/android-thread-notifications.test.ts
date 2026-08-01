import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const notifications = vi.hoisted(() => ({
  setChannel: vi.fn(async () => undefined),
  getPermissions: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  requestPermissions: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  schedule: vi.fn(async () => "notification-id"),
}));

vi.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 6 },
  AndroidNotificationPriority: { HIGH: "high" },
  setNotificationChannelAsync: notifications.setChannel,
  getPermissionsAsync: notifications.getPermissions,
  requestPermissionsAsync: notifications.requestPermissions,
  scheduleNotificationAsync: notifications.schedule,
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "background" },
  Platform: { OS: "android" },
}));

import {
  androidThreadNotificationContent,
  presentAndroidThreadNotification,
  requestAndroidAgentNotificationPermission,
} from "./android-thread-notifications";
import type {
  ThreadNotificationEvent,
  ThreadNotificationKind,
} from "./thread-notification-reducer";

function event(kind: ThreadNotificationKind): ThreadNotificationEvent {
  return {
    id: `event-${kind}`,
    kind,
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    threadTitle: "Prepare release",
    occurredAt: "2026-08-02T00:00:00.000Z",
  };
}

describe("Android thread notification content", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["completed", "Task completed", "Prepare release"],
    ["failed", "Task failed", "Prepare release needs attention."],
    ["approval-required", "Approval required", "Prepare release"],
    ["user-input-required", "Input required", "Prepare release"],
  ] as const)("maps %s to concise notification copy", (kind, title, body) => {
    expect(androidThreadNotificationContent(event(kind))).toEqual({ title, body });
  });

  it("creates the Android channel before requesting permission", async () => {
    notifications.getPermissions.mockResolvedValueOnce({ granted: false, canAskAgain: true });

    await expect(requestAndroidAgentNotificationPermission()).resolves.toEqual({
      type: "granted",
    });

    expect(notifications.setChannel).toHaveBeenCalledOnce();
    expect(notifications.requestPermissions).toHaveBeenCalledOnce();
    expect(notifications.setChannel.mock.invocationCallOrder[0]).toBeLessThan(
      notifications.requestPermissions.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("posts an immediate notification with stable dedupe and deep-link data", async () => {
    const notificationEvent = event("completed");

    await presentAndroidThreadNotification(notificationEvent);

    expect(notifications.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: notificationEvent.id,
        content: expect.objectContaining({
          title: "Task completed",
          data: expect.objectContaining({
            deepLink: "/threads/environment-1/thread-1",
            environmentId: "environment-1",
            threadId: "thread-1",
          }),
        }),
        trigger: { channelId: "agent-activity" },
      }),
    );
  });
});
