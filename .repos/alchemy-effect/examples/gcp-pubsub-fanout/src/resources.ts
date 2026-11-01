import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

/**
 * Every order event is published here once. Each consumer gets its own
 * subscription (created for it by `GCP.Run.TopicEventSource`), so each
 * sees every event it subscribes to, independently of the others.
 */
export const OrderEvents = GCP.PubSub.Topic("OrderEvents", {});

/**
 * Where Pub/Sub parks events the email consumer keeps failing on, after
 * `maxDeliveryAttempts` tries.
 */
export const DeadOrderEvents = GCP.PubSub.Topic("DeadOrderEvents", {});

/**
 * A topic without a subscription drops what is published to it, so the
 * dead letters need one to be kept. It is a pull subscription: an
 * operator (or the test) pulls from it to inspect or replay failures.
 */
export const DeadOrderEventsInbox = Effect.gen(function* () {
  const topic = yield* DeadOrderEvents;
  return yield* GCP.PubSub.Subscription("DeadOrderEventsInbox", {
    topic: topic.name,
    // Keep dead letters for the maximum 7 days.
    messageRetentionDuration: "604800s",
  });
});

/** The email consumer's outbox: one object per confirmation it sends. */
export const Outbox = GCP.Storage.Bucket("Outbox", {
  forceDestroy: true,
});

/** The analytics warehouse. */
export const Warehouse = GCP.BigQuery.Dataset("Warehouse", {
  forceDestroy: true,
});

/** One row per event the analytics consumer receives, of every type. */
export const OrderEventsTable = Effect.gen(function* () {
  const dataset = yield* Warehouse;
  return yield* GCP.BigQuery.Table("OrderEventsTable", {
    datasetId: dataset.datasetId,
    tableId: "order_events",
    schema: [
      { name: "eventId", type: "STRING", mode: "REQUIRED" },
      { name: "type", type: "STRING", mode: "REQUIRED" },
      { name: "orderId", type: "STRING", mode: "REQUIRED" },
      { name: "email", type: "STRING", mode: "REQUIRED" },
      { name: "total", type: "FLOAT", mode: "REQUIRED" },
      { name: "occurredAt", type: "TIMESTAMP", mode: "REQUIRED" },
      { name: "receivedAt", type: "TIMESTAMP", mode: "REQUIRED" },
    ],
  });
});

export type OrderEventType = "order.created" | "order.cancelled";

/**
 * What the API publishes. The type is also set as the message's `type`
 * attribute, which is what subscription filters match on.
 */
export interface OrderEvent {
  eventId: string;
  type: OrderEventType;
  orderId: string;
  email: string;
  total: number;
  occurredAt: string;
}

/** Outbox object for the confirmation of one event. */
export const emailObjectFor = (eventId: string) => `emails/${eventId}.json`;

/** Decode a pushed message's base64 JSON body. */
export const decodeOrderEvent = (data: string | undefined) =>
  Effect.try(
    () =>
      JSON.parse(
        Buffer.from(data ?? "", "base64").toString("utf8"),
      ) as OrderEvent,
  );
