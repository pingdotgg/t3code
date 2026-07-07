import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";

import { requestAgentNotificationPermission } from "./notificationPermissions";

const platformState = vi.hoisted(() => ({
  OS: "ios" as "ios" | "android" | "web",
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return platformState.OS;
    },
  },
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
}));

describe("requestAgentNotificationPermission", () => {
  beforeEach(() => {
    platformState.OS = "ios";
    vi.mocked(Notifications.getPermissionsAsync).mockReset();
    vi.mocked(Notifications.requestPermissionsAsync).mockReset();
  });

  it.effect("returns granted when iOS notification permission is already enabled", () =>
    Effect.gen(function* () {
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        granted: true,
        canAskAgain: true,
      } as never);

      const result = yield* requestAgentNotificationPermission;

      expect(result).toEqual({ type: "granted" });
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    }),
  );

  it.effect("requests iOS alert permissions when they are not granted yet", () =>
    Effect.gen(function* () {
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        granted: false,
        canAskAgain: true,
      } as never);
      vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
        granted: true,
        canAskAgain: true,
      } as never);

      const result = yield* requestAgentNotificationPermission;

      expect(result).toEqual({ type: "granted" });
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledWith({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      });
    }),
  );

  it.effect("requests Android POST_NOTIFICATIONS when permission is not granted yet", () =>
    Effect.gen(function* () {
      platformState.OS = "android";
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        granted: false,
        canAskAgain: true,
      } as never);
      vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
        granted: true,
        canAskAgain: true,
      } as never);

      const result = yield* requestAgentNotificationPermission;

      expect(result).toEqual({ type: "granted" });
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledWith();
    }),
  );

  it.effect("returns denied without requesting when Android permission cannot be asked again", () =>
    Effect.gen(function* () {
      platformState.OS = "android";
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        granted: false,
        canAskAgain: false,
      } as never);

      const result = yield* requestAgentNotificationPermission;

      expect(result).toEqual({ type: "denied", canAskAgain: false });
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    }),
  );

  it.effect("returns unsupported on platforms without agent notification permissions", () =>
    Effect.gen(function* () {
      platformState.OS = "web";

      const result = yield* requestAgentNotificationPermission;

      expect(result).toEqual({ type: "unsupported" });
      expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    }),
  );
});
