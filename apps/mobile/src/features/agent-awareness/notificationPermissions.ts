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

type NotificationPermissionShape = {
  readonly granted?: unknown;
  readonly status?: unknown;
  readonly canAskAgain?: unknown;
  readonly ios?: {
    readonly status?: unknown;
  };
};

function notificationPermissionShape(value: unknown) {
  return value as NotificationPermissionShape;
}

export function isNotificationPermissionGranted(status: unknown) {
  const permission = notificationPermissionShape(status);
  return (
    permission.granted === true ||
    permission.status === Notifications.PermissionStatus.GRANTED ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    permission.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

function canAskForNotificationPermission(status: unknown) {
  const permission = notificationPermissionShape(status);
  if (typeof permission.canAskAgain === "boolean") {
    return permission.canAskAgain;
  }
  return permission.status !== Notifications.PermissionStatus.DENIED;
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
  if (isNotificationPermissionGranted(existing)) {
    return { type: "granted" };
  }

  if (!canAskForNotificationPermission(existing)) {
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
  return isNotificationPermissionGranted(requested)
    ? { type: "granted" }
    : {
        type: "denied",
        canAskAgain: canAskForNotificationPermission(requested),
      };
});
