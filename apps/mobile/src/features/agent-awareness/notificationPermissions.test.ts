import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";
import { requestAgentNotificationPermission } from "./notificationPermissions";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationChannelAsync: vi.fn(() => Promise.resolve(null)),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true, canAskAgain: true })),
}));

describe("agent notification permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.OS = "android";
  });

  it.effect("creates an Android channel before prompting for notification permission", () =>
    Effect.gen(function* () {
      expect(yield* requestAgentNotificationPermission).toEqual({ type: "granted" });
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith("agent-alerts", {
        name: "Agent alerts",
        importance: 4,
      });
      expect(
        vi.mocked(Notifications.setNotificationChannelAsync).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(Notifications.requestPermissionsAsync).mock.invocationCallOrder[0]!);
    }),
  );

  it.effect("preserves denied permission when Android cannot ask again", () =>
    Effect.gen(function* () {
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
        granted: false,
        canAskAgain: false,
      } as Notifications.NotificationPermissionsStatus);
      expect(yield* requestAgentNotificationPermission).toEqual({
        type: "denied",
        canAskAgain: false,
      });
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps iOS permission requests free of Android channel setup", () =>
    Effect.gen(function* () {
      platform.OS = "ios";
      expect(yield* requestAgentNotificationPermission).toEqual({ type: "granted" });
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledWith({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
    }),
  );
});
