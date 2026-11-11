import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  NotificationEventSource,
  notificationPath,
  notificationSecretEnvName,
  type ConsumeNotificationsProps,
  type Notification,
  type NotificationEventSourceService,
  type NotifyingPolicy,
} from "./NotificationEventSource.ts";
import type { AlertType } from "./NotificationPolicy.ts";
import { NotificationWebhook } from "./Webhook.ts";

/**
 * `Cloudflare.Alerting.consumeNotifications` on any {@link WebhookHost}.
 *
 * Deploy-time: creates a {@link NotificationWebhook} destination pointing at
 * the host (at a per-policy path) and binds it onto the policy, so the policy
 * notifies the host. The webhook secret (yours, or a generated one) is bound
 * onto the host. Under `alchemy dev` the host is on localhost, which
 * Cloudflare can't reach, so no destination is created.
 *
 * Runtime: claims requests on the policy's path, rejects any without the
 * secret in `cf-webhook-auth`, acknowledges Cloudflare's test message, and
 * runs the handler once per notification.
 *
 * @layer
 * @product Alerting
 * @provides Cloudflare.Alerting.NotificationEventSource
 */
export const NotificationEventSourceLive = Layer.effect(
  NotificationEventSource,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    const createWebhook = yield* NotificationWebhook;

    return Effect.fn(function* (
      policy: NotifyingPolicy,
      props: ConsumeNotificationsProps,
      process: (notification: Notification) => Effect.Effect<void, never, never>,
    ) {
      const path = notificationPath(policy, props);

      const webhookSecret =
        props.secret ??
        (yield* Namespace.push(host.LogicalId, Random(`${policy.LogicalId}NotificationSecret`)))
          .text;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const context = yield* Effect.serviceOption(AlchemyContext);
            if (Option.isSome(context) && context.value.dev) {
              yield* Effect.logWarning(
                `Cloudflare.Alerting.consumeNotifications: no webhook destination for ${path} under alchemy dev; Cloudflare only delivers to public URLs, so deploy to receive notifications.`,
              );
              return;
            }
            const webhook = yield* createWebhook(`${policy.LogicalId}Notifications`, {
              url: Output.interpolate`${host.url}${path}`,
              secret: webhookSecret,
            });
            // A binding, not a prop: the webhook depends on the host's URL,
            // and the policy is declared without it.
            yield* policy.bind(`${host.LogicalId}:${path}`, {
              webhooks: [{ id: webhook.webhookId }],
            });
          }),
        );
      }

      // Registers the secret on the host at deploy, reads it back at runtime.
      const secret = yield* Output.named(
        Output.asOutput(webhookSecret),
        notificationSecretEnvName(policy),
      );

      yield* host.route(path, (request) => handleDelivery(request, secret, process));
    }) as NotificationEventSourceService;
  }),
);

const handleDelivery = <Req>(
  request: Request,
  secret: Effect.Effect<Redacted.Redacted<string> | undefined>,
  process: (notification: Notification) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const resolved = yield* secret;
    if (resolved === undefined) {
      return new Response("webhook secret missing", { status: 500 });
    }
    const auth = request.headers.get("cf-webhook-auth") ?? "";
    if (!timingSafeEqual(auth, Redacted.value(resolved))) {
      return new Response("invalid secret", { status: 401 });
    }

    const body = yield* Effect.promise(() => request.text());
    const payload = yield* Effect.try({
      try: (): Record<string, unknown> | undefined => JSON.parse(body),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (typeof payload !== "object" || payload === null) {
      return new Response("invalid payload", { status: 400 });
    }

    // Cloudflare tests a destination when it is created or updated with a
    // bare `{ text }` message: acknowledge it without running the handler.
    if (payload.alert_type === undefined && payload.data === undefined) {
      return new Response(null, { status: 200 });
    }

    yield* process(toNotification(payload)).pipe(Effect.orDie);
    return new Response(null, { status: 200 });
  });

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const toNotification = (payload: Record<string, unknown>): Notification => ({
  name: str(payload.name) ?? "",
  text: str(payload.text) ?? "",
  data:
    typeof payload.data === "object" && payload.data !== null
      ? (payload.data as Record<string, unknown>)
      : {},
  ts: typeof payload.ts === "number" ? payload.ts : Number(payload.ts ?? 0),
  accountId: str(payload.account_id),
  policyId: str(payload.policy_id),
  policyName: str(payload.policy_name),
  alertType: str(payload.alert_type) as AlertType | undefined,
  alertCorrelationId: str(payload.alert_correlation_id),
  alertEvent: str(payload.alert_event),
});

/**
 * Constant-time string comparison, so a forged header can't learn the secret
 * byte by byte from response timing.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
};
