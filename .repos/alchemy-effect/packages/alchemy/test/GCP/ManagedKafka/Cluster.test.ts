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
  kafka.getProjectsLocationsClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsClusters({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-missing-kafka`,
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
  "create, update, and delete a managed kafka cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ManagedKafka.Cluster("Brokers", {
            location: "us-central1",
            capacityConfig: { vcpuCount: 3, memoryBytes: 3_221_225_472 },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/clusters/");
      expect(created.state).toEqual("ACTIVE");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* kafka.getProjectsLocationsClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ManagedKafka.Cluster("Brokers", {
            clusterId: created.clusterId,
            location: "us-central1",
            capacityConfig: { vcpuCount: 3, memoryBytes: 3_221_225_472 },
            rebalanceConfig: { mode: "AUTO_REBALANCE_ON_SCALE_UP" },
            labels: { env: "prod" },
          });
        }),
      );
      expect(updated.clusterId).toEqual(created.clusterId);
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withKafkaClusterSlot),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 10_800_000,
    retry: 0,
  },
);
