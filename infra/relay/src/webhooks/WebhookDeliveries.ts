import type * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as WebhookInboxes from "./WebhookInboxes.ts";

const WebhookDeliveryJob = Schema.Struct({ deliveryId: Schema.String });
export type WebhookDeliveryJob = typeof WebhookDeliveryJob.Type;
const decodeJob = Schema.decodeUnknownEffect(WebhookDeliveryJob);

/**
 * Rejections no retry can fix: the link has no managed tunnel, or no longer
 * exists. Every other reason (allocation not ready, endpoint mismatch) can
 * heal while the tunnel recovers, so the delivery stays pending.
 */
const PERMANENT_REJECTIONS: ReadonlySet<string> = new Set([
  "endpoint_provider_not_managed",
  "environment_link_not_found",
]);

/** A delivery not attempted for this long is queued again by the cron sweep. */
export const WEBHOOK_DELIVERY_RETRY_AFTER_MINUTES = 5;
const WEBHOOK_DELIVERY_RETRY_BATCH = 100;

export class WebhookDeliveryError extends Schema.TaggedError<WebhookDeliveryError>()(
  "WebhookDeliveryError",
  {
    operation: Schema.Literals(["enqueue", "decode-job"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Webhook delivery '${this.operation}' failed.`;
  }
}

export class WebhookDeliveryQueueSender extends Context.Service<
  WebhookDeliveryQueueSender,
  {
    readonly send: (body: WebhookDeliveryJob) => Effect.Effect<void, Cloudflare.Queues.SendError>;
  }
>()("t3code-relay/webhooks/WebhookDeliveries/WebhookDeliveryQueueSender") {}

/**
 * Pushes stored webhook deliveries to their environment over its managed
 * tunnel, the same channel as the Connect health check. A delivery is deleted
 * once the environment's signed ack verifies; until then queue retries and the
 * cron sweep keep trying, so a machine that was asleep catches up when it is
 * reachable again.
 */
export class WebhookDeliveries extends Context.Service<
  WebhookDeliveries,
  {
    readonly enqueue: (deliveryId: string) => Effect.Effect<void, WebhookDeliveryError>;
    readonly process: (
      body: unknown,
    ) => Effect.Effect<
      void,
      | WebhookDeliveryError
      | WebhookInboxes.WebhookInboxPersistenceError
      | EnvironmentConnector.EnvironmentConnectorError
    >;
    /** Requeues deliveries whose last attempt is older than the retry window. */
    readonly retryPending: Effect.Effect<number, WebhookInboxes.WebhookInboxPersistenceError>;
  }
>()("t3code-relay/webhooks/WebhookDeliveries") {}

export const make = Effect.gen(function* () {
  const inboxes = yield* WebhookInboxes.WebhookInboxes;
  const connector = yield* EnvironmentConnector.EnvironmentConnector;
  const sender = yield* WebhookDeliveryQueueSender;

  const enqueue = (deliveryId: string) =>
    sender
      .send({ deliveryId })
      .pipe(Effect.mapError((cause) => new WebhookDeliveryError({ operation: "enqueue", cause })));

  return WebhookDeliveries.of({
    enqueue,

    process: Effect.fn("relay.webhook_deliveries.process")(function* (body) {
      const job = yield* decodeJob(body).pipe(
        Effect.mapError((cause) => new WebhookDeliveryError({ operation: "decode-job", cause })),
      );
      const target = yield* inboxes.getForDelivery(job.deliveryId);
      // Already delivered, expired, or its environment was unlinked. Deleting
      // covers the unlinked case so those rows never crowd out the retry sweep.
      if (target === null) {
        yield* inboxes.complete(job.deliveryId);
        return;
      }
      yield* inboxes.markAttempted({
        deliveryId: job.deliveryId,
        attemptedAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* connector.deliverWebhook(target).pipe(
        Effect.catchTag("EnvironmentConnectNotAuthorized", (error) =>
          PERMANENT_REJECTIONS.has(error.reason)
            ? Effect.logWarning("Dropping webhook delivery for an unreachable environment", {
                deliveryId: job.deliveryId,
                reason: error.reason,
              })
            : // A tunnel mid-recovery or a stale allocation can heal; keep retrying.
              Effect.fail(error),
        ),
      );
      yield* inboxes.complete(job.deliveryId);
    }),

    retryPending: Effect.gen(function* () {
      const now = yield* DateTime.now;
      const deliveryIds = yield* inboxes.listRetryable({
        attemptedBefore: DateTime.formatIso(
          DateTime.subtract(now, { minutes: WEBHOOK_DELIVERY_RETRY_AFTER_MINUTES }),
        ),
        limit: WEBHOOK_DELIVERY_RETRY_BATCH,
      });
      yield* Effect.forEach(
        deliveryIds,
        (deliveryId) =>
          enqueue(deliveryId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to requeue webhook delivery", {
                deliveryId,
                cause: error.cause,
              }),
            ),
          ),
        { discard: true },
      );
      return deliveryIds.length;
    }).pipe(Effect.withSpan("relay.webhook_deliveries.retry_pending")),
  });
});

export const layer = Layer.effect(WebhookDeliveries, make);
