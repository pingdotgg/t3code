import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam } from "../HttpBinding.ts";
import type {
  PulledMessage,
  ReadSubscriptionClient,
} from "./ReadSubscription.ts";
import type { Subscription } from "./Subscription.ts";
import type { Topic } from "./Topic.ts";
import type { PublishMessage, WriteTopicClient } from "./WriteTopic.ts";

/**
 * Shared HTTP scaffolding for the Pub/Sub `WriteTopic` / `ReadSubscription`
 * bindings. NOT exported from `index.ts`.
 */

export const writeTopicGrant: BindingIam = {
  role: "roles/pubsub.publisher",
  on: "pubsub.topic",
};

export const readSubscriptionGrant: BindingIam = {
  role: "roles/pubsub.subscriber",
  on: "pubsub.subscription",
};

const encode = (data: string | Uint8Array) =>
  typeof data === "string"
    ? Buffer.from(data, "utf8").toString("base64")
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
        "base64",
      );

const toPubsubMessage = (message: PublishMessage): pubsub.PubsubMessage => ({
  data: encode(message.data),
  attributes: message.attributes,
  orderingKey: message.orderingKey,
});

const decode = (received: pubsub.ReceivedMessage): PulledMessage => {
  const buffer = Buffer.from(received.message?.data ?? "", "base64");
  return {
    ...received,
    ackId: received.ackId ?? "",
    messageId: received.message?.messageId ?? "",
    data: new Uint8Array(buffer),
    text: buffer.toString("utf8"),
    attributes: Object.fromEntries(
      Object.entries(received.message?.attributes ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
};

export const makeWriteTopicBinding = Effect.gen(function* () {
  const publish = yield* pubsub.publishProjectsTopics;
  return Effect.fn(function* (topic: Topic) {
    yield* bindGcpHost({
      tag: "GCP.PubSub.WriteTopic",
      resource: topic,
      iam: [grantFor(writeTopicGrant, topic.name)],
    });
    const topicName = yield* topic.name;
    const publishBatch = (messages: ReadonlyArray<PublishMessage>) =>
      messages.length === 0
        ? Effect.succeed<string[]>([])
        : Effect.gen(function* () {
            const body = yield* Effect.sync(() => ({
              messages: messages.map(toPubsubMessage),
            }));
            const response = yield* publish({
              topic: yield* topicName,
              body,
            });
            return response.messageIds ?? [];
          });
    return {
      publish: (message) =>
        publishBatch([message]).pipe(Effect.map((ids) => ids[0] ?? "")),
      publishBatch,
    } satisfies WriteTopicClient;
  });
});

export const makeReadSubscriptionBinding = Effect.gen(function* () {
  const pull = yield* pubsub.pullProjectsSubscriptions;
  const acknowledge = yield* pubsub.acknowledgeProjectsSubscriptions;
  const modifyAckDeadline =
    yield* pubsub.modifyAckDeadlineProjectsSubscriptions;
  return Effect.fn(function* (subscription: Subscription) {
    yield* bindGcpHost({
      tag: "GCP.PubSub.ReadSubscription",
      resource: subscription,
      iam: [grantFor(readSubscriptionGrant, subscription.name)],
    });
    const subscriptionName = yield* subscription.name;
    return {
      pull: (options) =>
        Effect.gen(function* () {
          const response = yield* pull({
            subscription: yield* subscriptionName,
            body: {
              maxMessages: options?.maxMessages ?? 10,
              returnImmediately: options?.returnImmediately ?? false,
            },
          });
          return yield* Effect.sync(() =>
            (response.receivedMessages ?? []).map(decode),
          );
        }),
      acknowledge: (ackIds) =>
        ackIds.length === 0
          ? Effect.void
          : Effect.gen(function* () {
              yield* acknowledge({
                subscription: yield* subscriptionName,
                body: { ackIds: [...ackIds] },
              });
            }),
      modifyAckDeadline: (ackIds, seconds) =>
        ackIds.length === 0
          ? Effect.void
          : Effect.gen(function* () {
              yield* modifyAckDeadline({
                subscription: yield* subscriptionName,
                body: { ackIds: [...ackIds], ackDeadlineSeconds: seconds },
              });
            }),
    } satisfies ReadSubscriptionClient;
  });
});
