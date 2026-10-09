import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

/** Every ingested event lands here first. */
export const Events = GCP.PubSub.Topic("Events", {});

/** The warehouse the drain job writes into. */
export const Analytics = GCP.BigQuery.Dataset("Analytics", {
  forceDestroy: true,
});

/**
 * A pull subscription. Pub/Sub holds messages until they are acked, so
 * the drain can run on a schedule instead of keeping a consumer warm.
 *
 * Dependent resources go in an `Effect.gen` because the topic has to
 * exist before its name can be referenced. Yielding it twice is free —
 * resources are keyed by logical id, so both hosts get the same
 * subscription.
 */
export const Inbox = Effect.gen(function* () {
  const topic = yield* Events;
  return yield* GCP.PubSub.Subscription("Inbox", {
    topic: topic.name,
    ackDeadlineSeconds: 60,
  });
});

/**
 * `payload` is JSON rather than a column per attribute so producers can
 * add fields without a schema migration.
 */
export const EventsTable = Effect.gen(function* () {
  const dataset = yield* Analytics;
  return yield* GCP.BigQuery.Table("EventsTable", {
    datasetId: dataset.datasetId,
    tableId: "events",
    schema: [
      { name: "id", type: "STRING", mode: "REQUIRED" },
      { name: "type", type: "STRING", mode: "REQUIRED" },
      { name: "occurredAt", type: "TIMESTAMP", mode: "REQUIRED" },
      { name: "payload", type: "JSON" },
    ],
  });
});

/**
 * The envelope producers publish and the drain writes to BigQuery.
 *
 * A type alias rather than an interface: BigQuery's row payload is an
 * index-signature type, and only aliases get an implicit index signature.
 */
export type EventRow = {
  id: string;
  type: string;
  occurredAt: string;
  payload: string;
};
