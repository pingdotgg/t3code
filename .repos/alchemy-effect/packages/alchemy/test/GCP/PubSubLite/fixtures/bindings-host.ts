import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const Events = GCP.PubSubLite.AdminTopic("Events", {
  location: "us-central1-a",
});

export const Inbox = Effect.gen(function* () {
  const topic = yield* Events;
  return yield* GCP.PubSubLite.AdminSubscription("Inbox", {
    location: "us-central1-a",
    topic: topic.name,
  });
});

export const Capacity = GCP.PubSubLite.AdminReservation("Capacity", {
  location: "us-central1",
  throughputCapacity: "4",
});

export const COMMITTED_OFFSET = "0";

/**
 * Effect-native Cloud Run service exercising every Pub/Sub Lite binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class PubSubLiteBindingsHost extends GCP.Function<PubSubLiteBindingsHost>()(
  "PubSubLiteBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getTopic = yield* GCP.PubSubLite.GetTopic(Events);
    const getPartitions = yield* GCP.PubSubLite.GetPartitions(Events);
    const computeHead = yield* GCP.PubSubLite.ComputeHeadCursor(Events);
    const getSubscription = yield* GCP.PubSubLite.GetSubscription(Inbox);
    const commitCursor = yield* GCP.PubSubLite.CommitCursor(Inbox);
    const getReservation = yield* GCP.PubSubLite.GetReservation(Capacity);

    return {
      fetch: serveProbes({
        getTopic: getTopic(),
        getPartitions: getPartitions(),
        computeHeadCursor: computeHead({ body: { partition: "0" } }),
        getSubscription: getSubscription(),
        commitCursor: commitCursor({
          body: { partition: "0", cursor: { offset: COMMITTED_OFFSET } },
        }),
        getReservation: getReservation(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.PubSubLite.GetTopicHttp),
    Effect.provide(GCP.PubSubLite.GetPartitionsHttp),
    Effect.provide(GCP.PubSubLite.ComputeHeadCursorHttp),
    Effect.provide(GCP.PubSubLite.GetSubscriptionHttp),
    Effect.provide(GCP.PubSubLite.CommitCursorHttp),
    Effect.provide(GCP.PubSubLite.GetReservationHttp),
  ),
) {}
