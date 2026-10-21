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
});
