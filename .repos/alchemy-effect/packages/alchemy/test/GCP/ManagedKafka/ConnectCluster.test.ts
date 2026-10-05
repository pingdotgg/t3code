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
  kafka.getProjectsLocationsConnectClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsConnectClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsConnectClusters({
          name: `projects/${project}/locations/us-central1/connectClusters/alchemy-missing-connect`,
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
  "create, update, and delete a kafka connect cluster",
  (stack) =>
    Effect.gen(function* () {
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
          return { cluster, connect };
        }),
      );

      expect(created.connect.name).toContain("/connectClusters/");
      expect(created.connect.kafkaCluster).toEqual(created.cluster.name);

      const fetched = yield* kafka.getProjectsLocationsConnectClusters({
        name: created.connect.name,
      });
      expect(fetched.name).toEqual(created.connect.name);

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
            labels: { env: "prod" },
          });
          return { cluster, connect };
        }),
      );
      expect(updated.connect.connectClusterId).toEqual(
        created.connect.connectClusterId,
      );
      expect(updated.connect.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.connect.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withKafkaClusterSlot),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 10_800_000,
    retry: 0,
  },
);
