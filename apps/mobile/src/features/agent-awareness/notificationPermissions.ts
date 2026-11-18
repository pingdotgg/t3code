import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

export type NotificationPermissionResult =
  | { readonly type: "unsupported" }
  | { readonly type: "granted" }
  | { readonly type: "denied"; readonly canAskAgain: boolean };

export class NotificationPermissionReadError extends Schema.TaggedError<NotificationPermissionReadError>()(
  "NotificationPermissionReadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return m(msg("Failed to read notification permissions."));
  }
}

export class NotificationPermissionRequestError extends Schema.TaggedError<NotificationPermissionRequestError>()(
  "NotificationPermissionRequestError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return m(msg("Failed to request notification permissions."));
  }
}

export const requestAgentNotificationPermission: Effect.Effect<
  NotificationPermissionResult,
  NotificationPermissionReadError | NotificationPermissionRequestError
> = Effect.gen(function* () {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { type: "unsupported" };
  }

  if (Platform.OS === "android") {
    yield* Effect.tryPromise({
      try: () =>
        Notifications.setNotificationChannelAsync("agent-alerts", {
          name: m(msg("Agent alerts")),
          importance: Notifications.AndroidImportance.HIGH,
        }),
      catch: (cause) => new NotificationPermissionRequestError({ cause }),
    });
  }

  const existing = yield* Effect.tryPromise({
    try: () => Notifications.getPermissionsAsync(),
    catch: (cause) => new NotificationPermissionReadError({ cause }),
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
    catch: (cause) => new NotificationPermissionRequestError({ cause }),
  });
  return requested.granted
    ? { type: "granted" }
    : { type: "denied", canAskAgain: requested.canAskAgain };
});
