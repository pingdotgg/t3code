import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as file from "@distilled.cloud/gcp/file_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CAPACITY_ZONE } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Snapshots need a ZONAL/REGIONAL/ENTERPRISE instance, which draws on the
// `EnterpriseStorageGibPerRegion` quota. The testing project has none (limit
// 0), so the lifecycle is entitlement-gated; the probe below pins the typed
// rejection. Instances also take 5–20 minutes to provision.
const hasEnterpriseQuota = !!process.env.GCP_TEST_FILESTORE_ENTERPRISE;
const runLifecycle =
  hasEnterpriseQuota && !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  file.getProjectsLocationsInstancesSnapshots({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsInstancesSnapshots on a missing snapshot fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        file.getProjectsLocationsInstancesSnapshots({
          name: `projects/${project}/locations/us-central1-a/instances/alchemy-filestore-missing/snapshots/alchemy-snap-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:filestore", "live"], timeout: 90_000 },
);

test.provider.skipIf(hasEnterpriseQuota || !!process.env.FAST)(
  "a snapshot-capable instance without enterprise quota fails with StorageQuotaExceeded",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Filestore.Instance("Nfs", {
              location: CAPACITY_ZONE,
              tier: "ZONAL",
              fileShares: [{ name: "share1", capacityGb: 1024 }],
              networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            });
          }),
        ),
      );
      expect(error._tag).toEqual("StorageQuotaExceeded");

      yield* stack.destroy();
    }).pipe(logLevel),
  // If quota is ever granted the deploy creates a real instance; the budget
  // lets the final destroy remove it instead of abandoning teardown.
  {
    tags: ["provider:gcp", "provider:gcp:filestore", "live"],
    timeout: 2_700_000,
    retry: 0,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a filestore snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            location: CAPACITY_ZONE,
            tier: "ZONAL",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
            instance: nfs.name,
            description: "alchemy-test-snap",
            labels: { env: "test" },
          });
          return { nfs, snapshot };
        }),
      );

      expect(created.snapshot.name).toContain("/snapshots/");
      expect(created.snapshot.snapshotId).toEqual(expect.any(String));
      expect(created.snapshot.instance).toEqual(created.nfs.name);
      expect(created.snapshot.description).toEqual("alchemy-test-snap");
      expect(created.snapshot.labels).toMatchObject({ env: "test" });
      expect(created.snapshot.state).toEqual("READY");

      const fetched = yield* file.getProjectsLocationsInstancesSnapshots({
        name: created.snapshot.name,
      });
      expect(fetched.name).toEqual(created.snapshot.name);
      expect(fetched.description).toEqual("alchemy-test-snap");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            instanceId: created.nfs.instanceId,
            location: CAPACITY_ZONE,
            tier: "ZONAL",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const snapshot = yield* GCP.Filestore.InstancesSnapshot("Nightly", {
            instance: nfs.name,
            snapshotId: created.snapshot.snapshotId,
            description: "alchemy-prod-snap",
            labels: { env: "prod", role: "backup" },
          });
          return { nfs, snapshot };
        }),
      );

      expect(updated.snapshot.name).toEqual(created.snapshot.name);
      expect(updated.snapshot.description).toEqual("alchemy-prod-snap");
      expect(updated.snapshot.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const refetched = yield* file.getProjectsLocationsInstancesSnapshots({
        name: created.snapshot.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-snap");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.snapshot.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:filestore", "live"],
    timeout: 2_700_000,
    retry: 0,
  },
);
