import type * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Subscription } from "./Subscription.ts";

export interface PullSubscriptionOptions {
  /**
   * Maximum messages to return.
   * @default 10
   */
  maxMessages?: number;
  /**
   * Return immediately when no messages are available instead of waiting
   * briefly for some to arrive.
   * @default false
   */
  returnImmediately?: boolean;
}

/** A pulled message with its payload decoded. */
export interface PulledMessage extends pubsub.ReceivedMessage {
  /** Ack id for `acknowledge` / `modifyAckDeadline`. */
  ackId: string;
  /** Server-assigned message id. */
  messageId: string;
  /** Decoded message body. */
  data: Uint8Array;
  /** `data` decoded as UTF-8. */
  text: string;
  /** Message attributes (empty when none were set). */
  attributes: Record<string, string>;
}

/** Consumer client for one Pub/Sub subscription. */
export interface ReadSubscriptionClient {
  /** Pull up to `maxMessages` messages; an empty array when none arrived. */
  pull(
    options?: PullSubscriptionOptions,
  ): Effect.Effect<
    PulledMessage[],
    pubsub.PullProjectsSubscriptionsError,
    RuntimeContext
  >;
  /** Acknowledge messages by ack id. An empty list is a no-op. */
  acknowledge(
    ackIds: ReadonlyArray<string>,
  ): Effect.Effect<
    void,
    pubsub.AcknowledgeProjectsSubscriptionsError,
    RuntimeContext
  >;
  /**
   * Extend (or, with `0`, release for redelivery) the ack deadline of
   * messages. An empty list is a no-op.
   */
  modifyAckDeadline(
    ackIds: ReadonlyArray<string>,
    seconds: number,
  ): Effect.Effect<
    void,
    pubsub.ModifyAckDeadlineProjectsSubscriptionsError,
    RuntimeContext
  >;
}

/**
 * Consume access to a Pub/Sub {@link Subscription}: `pull`, `acknowledge`,
 * `modifyAckDeadline`. Grants `roles/pubsub.subscriber` on the subscription
 * only.
 *
 * ### Consuming messages
 * **Example:** Pull and acknowledge
 * ```typescript
 * const inbox = yield* GCP.PubSub.ReadSubscription(subscription);
 * const messages = yield* inbox.pull({ maxMessages: 10 });
 * for (const message of messages) {
 *   yield* Effect.log(message.text, message.attributes);
 * }
 * yield* inbox.acknowledge(messages.map((m) => m.ackId));
 * // …provided with Effect.provide(GCP.PubSub.ReadSubscriptionHttp)
 * ```
 *
 * **Example:** Release a message for redelivery
 * ```typescript
 * yield* inbox.modifyAckDeadline([message.ackId], 0);
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface ReadSubscription extends Binding.Service<
  ReadSubscription,
  "GCP.PubSub.ReadSubscription",
  (subscription: Subscription) => Effect.Effect<ReadSubscriptionClient>
> {}

export const ReadSubscription = Binding.Service<ReadSubscription>(
  "GCP.PubSub.ReadSubscription",
);
