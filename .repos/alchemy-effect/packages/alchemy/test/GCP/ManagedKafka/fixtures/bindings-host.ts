import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const Brokers = GCP.ManagedKafka.Cluster("Brokers", {
  location: "us-central1",
});

export const Events = Effect.gen(function* () {
  const cluster = yield* Brokers;
  return yield* GCP.ManagedKafka.ClustersTopic("Events", {
    cluster: cluster.name,
  });
});

export const Connect = Effect.gen(function* () {
  const cluster = yield* Brokers;
  return yield* GCP.ManagedKafka.ConnectCluster("Connect", {
    kafkaCluster: cluster.name,
    labels: { env: "test" },
  });
});

// The Schema Registry API requires a Kafka cluster in the region.
export const Schemas = Effect.gen(function* () {
  const cluster = yield* Brokers;
  return yield* GCP.ManagedKafka.SchemaRegistry("Schemas", {
    location: cluster.location,
  });
});

/**
 * Effect-native Cloud Run service exercising every Managed Kafka binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class KafkaBindingsHost extends GCP.Function<KafkaBindingsHost>()(
  "KafkaBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getCluster = yield* GCP.ManagedKafka.GetCluster(yield* Brokers);
    const getTopic = yield* GCP.ManagedKafka.GetTopic(yield* Events);
    const getConnect = yield* GCP.ManagedKafka.GetConnectCluster(
      yield* Connect,
    );
    const getRegistry = yield* GCP.ManagedKafka.GetSchemaRegistry(
      yield* Schemas,
    );

    return {
      fetch: serveProbes({
        getCluster: getCluster(),
        getTopic: getTopic(),
        getConnectCluster: getConnect(),
        getSchemaRegistry: getRegistry(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.ManagedKafka.GetClusterHttp),
    Effect.provide(GCP.ManagedKafka.GetTopicHttp),
    Effect.provide(GCP.ManagedKafka.GetConnectClusterHttp),
    Effect.provide(GCP.ManagedKafka.GetSchemaRegistryHttp),
  ),
) {}
