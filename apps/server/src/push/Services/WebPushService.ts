import type {
  AuthSessionId,
  ServerPushConfig,
  ServerPushSendResult,
  ServerPushSubscriptionStatus,
  ServerRegisterPushSubscriptionInput,
  ServerSendTestPushNotificationInput,
  ServerUnregisterPushSubscriptionInput,
  ServerPushNotificationPayload,
} from "@t3tools/contracts";
import { ServerPushNotificationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type WebPushSendInput = {
  readonly payload: ServerPushNotificationPayload;
};

export interface WebPushServiceShape {
  readonly getConfig: Effect.Effect<ServerPushConfig, ServerPushNotificationError>;
  readonly registerSubscription: (
    sessionId: AuthSessionId,
    input: ServerRegisterPushSubscriptionInput,
  ) => Effect.Effect<ServerPushSubscriptionStatus, ServerPushNotificationError>;
  readonly unregisterSubscription: (
    sessionId: AuthSessionId,
    input: ServerUnregisterPushSubscriptionInput,
  ) => Effect.Effect<ServerPushSubscriptionStatus, ServerPushNotificationError>;
  readonly sendTestNotification: (
    sessionId: AuthSessionId,
    input: ServerSendTestPushNotificationInput,
  ) => Effect.Effect<ServerPushSendResult, ServerPushNotificationError>;
  readonly sendToActiveSubscriptions: (
    input: WebPushSendInput,
  ) => Effect.Effect<ServerPushSendResult, ServerPushNotificationError>;
}

export class WebPushService extends Context.Service<WebPushService, WebPushServiceShape>()(
  "salchi/push/Services/WebPushService",
) {}
