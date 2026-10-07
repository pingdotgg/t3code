import * as GCP from "alchemy/GCP";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  DeadOrderEvents,
  decodeOrderEvent,
  emailObjectFor,
  OrderEvents,
  Outbox,
  type OrderEvent,
} from "./resources.ts";

/** How many times Pub/Sub tries a message before dead-lettering it. */
export const MAX_DELIVERY_ATTEMPTS = 5;

class UndeliverableEmail extends Data.TaggedError("UndeliverableEmail")<{
  to: string;
}> {}

/**
 * Stand-in for a mail provider. `.invalid` is reserved (RFC 2606) and
 * never resolves, so mail to it always fails — a message this consumer
 * can never process, which is what the dead-letter topic is for.
 */
interface SentEmail {
  to: string;
  subject: string;
  text: string;
  sentAt: string;
}

const send = (
  event: OrderEvent,
): Effect.Effect<SentEmail, UndeliverableEmail> =>
  event.email.endsWith(".invalid")
    ? Effect.fail(new UndeliverableEmail({ to: event.email }))
    : Effect.succeed({
        to: event.email,
        subject: `Order ${event.orderId} confirmed`,
        text: `Thanks! We received your order totalling $${event.total.toFixed(2)}.`,
        sentAt: new Date().toISOString(),
      });

/**
 * Sends an order confirmation for every `order.created` event.
 *
 * The `filter` is applied by Pub/Sub on the subscription, so other event
 * types are never delivered here at all — this service is not woken up
 * (or billed) for them.
 *
 * A failed send fails the push; Pub/Sub retries it, and after
 * {@link MAX_DELIVERY_ATTEMPTS} attempts forwards it to
 * `DeadOrderEvents` instead of retrying forever.
 */
export default class Email extends GCP.Function<Email>()(
  "Email",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const outbox = yield* GCP.Storage.WriteBucket(Outbox);

    yield* GCP.PubSub.consumeTopicMessages(
      OrderEvents,
      {
        filter: 'attributes.type = "order.created"',
        deadLetter: {
          topic: yield* DeadOrderEvents,
          maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS,
        },
      },
      (messages) =>
        messages.pipe(
          Stream.runForEach(({ message, deliveryAttempt }) =>
            Effect.gen(function* () {
              const event = yield* decodeOrderEvent(message.data);
              const email = yield* send(event).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning(
                    `email: cannot send to ${error.to} (attempt ${deliveryAttempt ?? 1})`,
                  ),
                ),
              );
              // Keyed by event id, so a redelivery overwrites instead of
              // recording a second email.
              yield* outbox.put(
                emailObjectFor(event.eventId),
                JSON.stringify(email),
                {
                  contentType: "application/json",
                  metadata: { orderId: event.orderId, to: email.to },
                },
              );
              yield* Effect.log(`email: confirmed ${event.orderId}`);
            }),
          ),
          // A failure answers the push with a 500, so Pub/Sub redelivers.
          Effect.orDie,
        ),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide([GCP.Run.TopicEventSource, GCP.Storage.WriteBucketHttp]),
  ),
) {}
