import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Partitions need an ENTERPRISE_PLUS instance plus a partition at 1000 PU each
// (~$10/h) and more node quota than the default testing project has
// (`Project 457525637530 cannot add 1 nodes in region us-central1.`). Set
// GCP_TEST_SPANNER_PARTITIONS=1 to opt in.
const runLifecycle =
  !!process.env.GCP_TEST_SPANNER_PARTITIONS && !process.env.FAST;

const waitUntilGone = (name: string) =>
  spanner.getProjectsInstancesInstancePartitions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesInstancePartitions on a missing partition fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        spanner.getProjectsInstancesInstancePartitions({
          name: `projects/${project}/instances/alchemy-spanner-missing/instancePartitions/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a spanner instance partition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            config: "regional-us-central1",
            processingUnits: 1000,
            displayName: "alchemy-pt-spnr",
            edition: "ENTERPRISE_PLUS",
            defaultBackupScheduleType: "NONE",
          });
          const partition = yield* GCP.Spanner.InstancesInstancePartition(
            "West",
            {
              instance: instance.instanceId,
              config: "regional-us-west1",
              displayName: "alchemy-west-pt",
              processingUnits: 1000,
            },
          );
          return { instance, partition };
        }),
      );

      expect(created.partition.name).toContain("/instancePartitions/");
      expect(created.partition.instancePartitionId).toEqual(expect.any(String));
      expect(created.partition.instanceId).toEqual(created.instance.instanceId);
      expect(created.partition.config).toContain("regional-us-west1");
      expect(created.partition.displayName).toEqual("alchemy-west-pt");
      expect(created.partition.state).toEqual("READY");

      const fetched = yield* spanner.getProjectsInstancesInstancePartitions({
        name: created.partition.name,
      });
      expect(fetched.name).toEqual(created.partition.name);
      expect(fetched.displayName).toEqual("alchemy-west-pt");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            instanceId: created.instance.instanceId,
            config: "regional-us-central1",
            processingUnits: 1000,
            displayName: "alchemy-pt-spnr",
            edition: "ENTERPRISE_PLUS",
            defaultBackupScheduleType: "NONE",
          });
          const partition = yield* GCP.Spanner.InstancesInstancePartition(
            "West",
            {
              instance: instance.instanceId,
              instancePartitionId: created.partition.instancePartitionId,
              config: "regional-us-west1",
              displayName: "alchemy-prod-pt",
              processingUnits: 1000,
            },
          );
          return { instance, partition };
        }),
      );

      expect(updated.partition.name).toEqual(created.partition.name);
      expect(updated.partition.displayName).toEqual("alchemy-prod-pt");

      const refetched = yield* spanner.getProjectsInstancesInstancePartitions({
        name: created.partition.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-pt");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.partition.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 180_000 },
);
