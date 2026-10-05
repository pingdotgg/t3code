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

// The Schema Registry API refuses every call until a Kafka cluster exists in
// the region (`SchemaRegistryRequiresCluster`), so lifecycle tests deploy a
// cluster first and make the registry depend on it. Clusters take ~30 minutes.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  kafka.getProjectsLocationsSchemaRegistries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "SchemaRegistryRequiresCluster"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSchemaRegistries on a missing registry fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsSchemaRegistries({
          name: `projects/${project}/locations/us-central1/schemaRegistries/alchemy_missing_registry`,
        }),
      );
      // Without a cluster in the region every call is refused; with one
      // (other suites create them concurrently) the registry is just missing.
      expect(["SchemaRegistryRequiresCluster", "NotFound"]).toContain(
        error._tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, refresh, and delete a schema registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            location: "us-central1",
          });
          const registry = yield* GCP.ManagedKafka.SchemaRegistry("Schemas", {
            location: cluster.location,
          });
          return { cluster, registry };
        }),
      );
      const created = deployed.registry;

      expect(created.name).toContain("/schemaRegistries/");
      expect(created.schemaRegistryId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");

      const fetched = yield* kafka.getProjectsLocationsSchemaRegistries({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            clusterId: deployed.cluster.clusterId,
            location: "us-central1",
          });
          return yield* GCP.ManagedKafka.SchemaRegistry("Schemas", {
            schemaRegistryId: created.schemaRegistryId,
            location: cluster.location,
          });
        }),
      );
      expect(updated.name).toEqual(created.name);

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
