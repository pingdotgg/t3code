import type * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Topic } from "./Topic.ts";

/** A message to publish. `data` is base64-encoded for you. */
export interface PublishMessage {
  /** Message body; strings are UTF-8 encoded. */
  data: string | Uint8Array;
  /** Optional message attributes. */
  attributes?: Record<string, string>;
  /** Ordering key; requires message ordering on the subscription. */
  orderingKey?: string;
}

/** Publish-only client for one Pub/Sub topic. */
export interface WriteTopicClient {
  /** Publish one message and return its server-assigned message id. */
  publish(
    message: PublishMessage,
  ): Effect.Effect<string, pubsub.PublishProjectsTopicsError, RuntimeContext>;
  /** Publish messages in one request; ids are returned in input order. */
  publishBatch(
    messages: ReadonlyArray<PublishMessage>,
  ): Effect.Effect<string[], pubsub.PublishProjectsTopicsError, RuntimeContext>;
}

/**
 * Publish access to a Pub/Sub {@link Topic}: `publish`, `publishBatch`.
 * Grants `roles/pubsub.publisher` on the topic only. Topics have no runtime
 * read — consume through a subscription with `ReadSubscription`.
 *
 * ### Publishing messages
 * **Example:** Publish one message
 * ```typescript
 * const events = yield* GCP.PubSub.WriteTopic(topic);
 * const messageId = yield* events.publish({
 *   data: JSON.stringify({ type: "signup" }),
 *   attributes: { source: "api" },
 * });
 * // …provided with Effect.provide(GCP.PubSub.WriteTopicHttp)
 * ```
 *
 * **Example:** Publish a batch
 * ```typescript
 * const events = yield* GCP.PubSub.WriteTopic(topic);
 * const ids = yield* events.publishBatch([{ data: "a" }, { data: "b" }]);
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface WriteTopic extends Binding.Service<
  WriteTopic,
  "GCP.PubSub.WriteTopic",
  (topic: Topic) => Effect.Effect<WriteTopicClient>
> {}

export const WriteTopic = Binding.Service<WriteTopic>("GCP.PubSub.WriteTopic");
