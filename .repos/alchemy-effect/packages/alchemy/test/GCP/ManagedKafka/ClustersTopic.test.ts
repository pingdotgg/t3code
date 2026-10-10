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
  kafka.getProjectsLocationsClustersTopics({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsClustersTopics on a missing topic fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsClustersTopics({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-missing/topics/alchemy-missing`,
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
  "create, update, and delete a kafka topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const topic = yield* GCP.ManagedKafka.ClustersTopic("Events", {
            cluster: cluster.name,
            partitionCount: 1,
            replicationFactor: 3,
            configs: { "retention.ms": "86400000" },
          });
          return { cluster, topic };
        }),
      );

      expect(created.topic.name).toContain("/topics/");
      expect(created.topic.partitionCount).toEqual(1);

      const fetched = yield* kafka.getProjectsLocationsClustersTopics({
        name: created.topic.name,
      });
      expect(fetched.name).toEqual(created.topic.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const topic = yield* GCP.ManagedKafka.ClustersTopic("Events", {
            cluster: cluster.name,
            topicId: created.topic.topicId,
            partitionCount: 3,
            replicationFactor: 3,
            configs: { "retention.ms": "172800000" },
          });
          return { cluster, topic };
        }),
      );
      expect(updated.topic.topicId).toEqual(created.topic.topicId);
      expect(updated.topic.partitionCount).toEqual(3);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.topic.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withKafkaClusterSlot),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 10_800_000,
    retry: 0,
  },
);
