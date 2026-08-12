import { sendPushNotification } from "@mmmike/web-push/send";
import type { DesktopNotificationKind } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import {
  agentNotificationKind,
  notificationBody,
  notificationTitle,
} from "@t3tools/shared/agentNotifications";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";

export interface WebPushNotificationPayload {
  readonly version: 1;
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly tag: string;
  readonly updatedAt: string;
  readonly silent: boolean;
}

export class WebPushDeliveryError extends Schema.TaggedErrorClass<WebPushDeliveryError>()(
  "WebPushDeliveryError",
  {
    userId: Schema.String,
    subscriptionId: Schema.String,
    stage: Schema.Literal("send"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Web Push delivery failed during ${this.stage} for subscription ${this.subscriptionId}.`;
  }
}

function kindEnabled(
  kind: DesktopNotificationKind,
  preferences: WebPushSubscriptions.WebPushTarget["preferences"],
): boolean {
  switch (kind) {
    case "task-completed":
      return preferences.notifyOnCompletion;
    case "task-failed":
      return preferences.notifyOnFailure;
    case "approval-needed":
      return preferences.notifyOnApproval;
  }
}

export function makeWebPushNotification(input: {
  readonly previousState: RelayAgentActivityState | null;
  readonly nextState: RelayAgentActivityState | null;
  readonly target: WebPushSubscriptions.WebPushTarget;
}): WebPushNotificationPayload | null {
  if (input.nextState === null) {
    return null;
  }
  const kind = agentNotificationKind(input.previousState?.phase ?? null, input.nextState.phase);
  if (kind === null || !kindEnabled(kind, input.target.preferences)) {
    return null;
  }
  const state = input.nextState;
  return {
    version: 1,
    title: notificationTitle(kind, state.projectTitle),
    body: notificationBody({
      responseText: state.detail ?? null,
      threadTitle: state.threadTitle,
      fallbackHeadline: state.headline,
    }),
    path: `/${encodeURIComponent(state.environmentId)}/${encodeURIComponent(state.threadId)}`,
    tag: `t3-agent-${state.environmentId}-${state.threadId}`,
    updatedAt: state.updatedAt,
    silent: !input.target.preferences.soundEnabled,
  };
}

export class WebPushDeliveries extends Context.Service<
  WebPushDeliveries,
  {
    readonly sendForUser: (input: {
      readonly userId: string;
      readonly previousState: RelayAgentActivityState | null;
      readonly nextState: RelayAgentActivityState | null;
    }) => Effect.Effect<
      void,
      WebPushDeliveryError | WebPushSubscriptions.WebPushSubscriptionPersistenceError
    >;
  }
>()("t3code-relay/agentActivity/WebPushDeliveries") {}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;

  const send = Effect.fnUntraced(function* (input: {
    readonly target: WebPushSubscriptions.WebPushTarget;
    readonly notification: WebPushNotificationPayload;
  }) {
    const delivered = yield* Effect.tryPromise({
      try: () =>
        sendPushNotification(
          {
            endpoint: input.target.endpoint,
            keys: { p256dh: input.target.p256dh, auth: input.target.auth },
          },
          input.notification,
          {
            subject: config.webPush.subject,
            publicKey: config.webPush.publicKey,
            privateKey: Redacted.value(config.webPush.privateKey),
          },
          { ttl: 60 },
        ),
      catch: (cause) =>
        new WebPushDeliveryError({
          userId: input.target.userId,
          subscriptionId: input.target.subscriptionId,
          stage: "send",
          cause,
        }),
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.mapError(
        (cause) =>
          new WebPushDeliveryError({
            userId: input.target.userId,
            subscriptionId: input.target.subscriptionId,
            stage: "send",
            cause,
          }),
      ),
    );
    if (!delivered) {
      yield* subscriptions.invalidate({
        userId: input.target.userId,
        subscriptionId: input.target.subscriptionId,
      });
    }
  });

  return WebPushDeliveries.of({
    sendForUser: Effect.fn("relay.web_push_deliveries.send_for_user")(function* (input) {
      const targets = yield* subscriptions.listForUser({ userId: input.userId });
      yield* Effect.forEach(
        targets,
        (target) => {
          const notification = makeWebPushNotification({ ...input, target });
          return notification === null
            ? Effect.void
            : send({ target, notification }).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Web Push notification delivery failed", {
                    errorTag: error._tag,
                    subscriptionId: target.subscriptionId,
                  }),
                ),
                Effect.ignore,
              );
        },
        { concurrency: 4 },
      );
    }),
  });
});

export const layer = Layer.effect(WebPushDeliveries, make);
