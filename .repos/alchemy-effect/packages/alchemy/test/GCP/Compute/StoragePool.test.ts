import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const zone = "us-central1-a";
const runLifecycle = !!process.env.GCP_TEST_STORAGE_POOL && !process.env.FAST;

const waitUntilGone = (
  projectId: string,
  poolZone: string,
  storagePool: string,
) =>
  compute
    .getStoragePools({
      project: projectId,
      zone: poolZone,
      storagePool,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getStoragePools on a missing pool fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getStoragePools({
          project,
          zone,
          storagePool: "alchemy-missing-storage-pool",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.GCP_TEST_STORAGE_POOL)(
  "insertStoragePools below minimum capacity fails with BadRequest",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.insertStoragePools({
          project,
          zone,
          body: {
            name: "alchemy-storage-pool-probe",
            storagePoolType: `projects/${project}/zones/${zone}/storagePoolTypes/hyperdisk-balanced`,
            poolProvisionedCapacityGb: "10",
          },
        }),
      );
      expect(error._tag).toBe("BadRequest");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a storage pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.StoragePool("Disks", {
            zone,
            description: "shared hyperdisk",
            storagePoolType: "hyperdisk-balanced",
            poolProvisionedCapacityGb: 10240,
            poolProvisionedIops: 10000,
            poolProvisionedThroughput: 1024,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.storagePoolName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.state).toEqual("READY");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.poolProvisionedCapacityGb).toEqual("10240");

      const fetched = yield* compute.getStoragePools({
        project: created.project,
        zone: created.zone,
        storagePool: created.storagePoolName,
      });
      expect(fetched.name).toEqual(created.storagePoolName);
      expect(fetched.state).toEqual("READY");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.StoragePool("Disks", {
            storagePoolName: created.storagePoolName,
            zone,
            description: "shared hyperdisk v2",
            storagePoolType: "hyperdisk-balanced",
            poolProvisionedCapacityGb: 10240,
            poolProvisionedIops: 11000,
            poolProvisionedThroughput: 1024,
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.storagePoolName).toEqual(created.storagePoolName);
      expect(updated.description).toEqual("shared hyperdisk v2");
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.project,
        created.zone,
        created.storagePoolName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
