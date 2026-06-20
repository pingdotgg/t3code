import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";

export type NotificationPermissionResult =
  | { readonly type: "unsupported" }
  | { readonly type: "granted" }
  | { readonly type: "denied"; readonly canAskAgain: boolean };

export class NotificationPermissionReadError extends Schema.TaggedErrorClass<NotificationPermissionReadError>()(
  "NotificationPermissionReadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to read notification permissions on iOS.";
  }
}

export class NotificationPermissionRequestError extends Schema.TaggedErrorClass<NotificationPermissionRequestError>()(
  "NotificationPermissionRequestError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to request notification permissions on iOS.";
  }
}

export const requestAgentNotificationPermission: Effect.Effect<
  NotificationPermissionResult,
  NotificationPermissionReadError | NotificationPermissionRequestError
> = Effect.gen(function* () {
  if (Platform.OS !== "ios") {
    return { type: "unsupported" };
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
