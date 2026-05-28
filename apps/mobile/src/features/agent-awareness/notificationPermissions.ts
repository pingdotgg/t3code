import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import { Platform } from "react-native";

export type NotificationPermissionResult =
  | { readonly type: "unsupported" }
  | { readonly type: "granted" }
  | { readonly type: "denied"; readonly canAskAgain: boolean };

export const requestAgentNotificationPermission: Effect.Effect<
  NotificationPermissionResult,
  unknown
> = Effect.gen(function* () {
  if (Platform.OS !== "ios") {
    return { type: "unsupported" };
  }

  const existing = yield* Effect.tryPromise({
    try: () => Notifications.getPermissionsAsync(),
    catch: (error) => error,
  });
  if (existing.granted) {
    return { type: "granted" };
  }

  if (!existing.canAskAgain) {
    return { type: "denied", canAskAgain: false };
  }

  const requested = yield* Effect.tryPromise({
    try: () =>
      Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
        },
      }),
    catch: (error) => error,
  });
  return requested.granted
    ? { type: "granted" }
    : { type: "denied", canAskAgain: requested.canAskAgain };
});
