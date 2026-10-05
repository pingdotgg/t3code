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

const AVRO = JSON.stringify({
  type: "record",
  name: "Shipment",
  namespace: "alchemy",
  fields: [{ name: "id", type: "string" }],
});

const waitUntilGone = (name: string) =>
  kafka
    .getProjectsLocationsSchemaRegistriesContextsSubjectsVersions({ name })
    .pipe(
      Effect.as("found" as const),
      // Once the parent registry is deleted too, the path itself is invalid.
      Effect.catchTag(
        [
          "NotFound",
          "SchemaRegistryRequiresCluster",
          "SchemaRegistryPathNotFound",
        ],
        () => Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsSchemaRegistriesContextsSubjectsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsSchemaRegistriesContextsSubjectsVersions({
          name: `projects/${project}/locations/us-central1/schemaRegistries/alchemy_missing/contexts/dev/subjects/missing/versions/1`,
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
  "create and delete a context-scoped schema subject version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.ManagedKafka.Cluster("Brokers", {
            location: "us-central1",
          });
          const registry = yield* GCP.ManagedKafka.SchemaRegistry("Schemas", {
            location: cluster.location,
          });
          const version =
            yield* GCP.ManagedKafka.SchemaRegistriesContextsSubjectsVersion(
              "ShipSchema",
              {
                schemaRegistry: registry.name,
                context: "dev",
                subject: "shipments",
                schemaType: "AVRO",
                schema: AVRO,
              },
            );
          return { registry, version };
        }),
      );

      expect(created.version.name).toContain("/contexts/");
      expect(created.version.context).toEqual("dev");
      expect(created.version.subject).toEqual("shipments");
      expect(created.version.version).toBeGreaterThan(0);

      const fetched =
        yield* kafka.getProjectsLocationsSchemaRegistriesContextsSubjectsVersions(
          { name: created.version.name },
        );
      // The API qualifies context-scoped subjects as `:.{context}:{subject}`.
      expect(fetched.subject).toEqual(":.dev:shipments");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withKafkaClusterSlot),
  {
    tags: ["provider:gcp", "provider:gcp:managedkafka", "live"],
    timeout: 10_800_000,
    retry: 0,
  },
);
