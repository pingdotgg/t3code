import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { withKafkaClusterSlot } from "./quota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Kafka and Connect clusters take ~30 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  kafka.getProjectsLocationsConnectClustersConnectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsConnectClustersConnectors on a missing connector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsConnectClustersConnectors({
          name: `projects/${project}/locations/us-central1/connectClusters/alchemy-missing/connectors/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a kafka connector",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const connect = yield* GCP.ManagedKafka.ConnectCluster("Connect", {
            kafkaCluster: cluster.name,
            labels: { env: "test" },
          });
          const connector = yield* GCP.ManagedKafka.ConnectClustersConnector(
            "Sink",
            {
              connectCluster: connect.name,
              configs: {
                "connector.class":
                  "com.google.pubsub.kafka.sink.CloudPubSubSinkConnector",
                "tasks.max": "1",
                topics: "orders",
                "cps.project": project,
                "cps.topic": "alchemy-managedkafka-sink",
              },
            },
          );
          return { cluster, connect, connector };
        }),
      );

      expect(created.connector.name).toContain("/connectors/");
      expect(created.connector.configs["connector.class"]).toContain("PubSub");

      const fetched =
        yield* kafka.getProjectsLocationsConnectClustersConnectors({
          name: created.connector.name,
        });
      expect(fetched.name).toEqual(created.connector.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const connect = yield* GCP.ManagedKafka.ConnectCluster("Connect", {
            connectClusterId: created.connect.connectClusterId,
            kafkaCluster: cluster.name,
            labels: { env: "test" },
          });
          const connector = yield* GCP.ManagedKafka.ConnectClustersConnector(
            "Sink",
            {
              connectCluster: connect.name,
              connectorId: created.connector.connectorId,
              configs: {
                "connector.class":
                  "com.google.pubsub.kafka.sink.CloudPubSubSinkConnector",
                "tasks.max": "2",
                topics: "orders",
                "cps.project": project,
                "cps.topic": "alchemy-managedkafka-sink",
              },
            },
          );
          return { cluster, connect, connector };
        }),
      );
      expect(updated.connector.connectorId).toEqual(
        created.connector.connectorId,
      );
      expect(updated.connector.configs["tasks.max"]).toEqual("2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.connector.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withKafkaClusterSlot),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 10_800_000,
    retry: 0,
  },
);
