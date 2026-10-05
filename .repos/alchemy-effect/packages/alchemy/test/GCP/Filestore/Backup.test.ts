import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as file from "@distilled.cloud/gcp/file_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CAPACITY_REGION, CAPACITY_ZONE } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Filestore instances take 5–20 minutes to provision and several to delete.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  file.getProjectsLocationsBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        file.getProjectsLocationsBackups({
          name: `projects/${project}/locations/us-central1/backups/alchemy-filestore-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:filestore", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a filestore backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            location: CAPACITY_ZONE,
            tier: "BASIC_HDD",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const backup = yield* GCP.Filestore.Backup("Nightly", {
            sourceInstance: nfs.name,
            sourceFileShare: "share1",
            location: CAPACITY_REGION,
            description: "alchemy-test-backup",
            labels: { env: "test" },
          });
          return { nfs, backup };
        }),
      );

      expect(created.backup.name).toContain("/backups/");
      expect(created.backup.backupId).toEqual(expect.any(String));
      expect(created.backup.location).toEqual(CAPACITY_REGION);
      expect(created.backup.sourceInstance).toEqual(created.nfs.name);
      expect(created.backup.sourceFileShare).toEqual("share1");
      expect(created.backup.description).toEqual("alchemy-test-backup");
      expect(created.backup.labels).toMatchObject({ env: "test" });
      expect(created.backup.state).toEqual("READY");

      const fetched = yield* file.getProjectsLocationsBackups({
        name: created.backup.name,
      });
      expect(fetched.name).toEqual(created.backup.name);
      expect(fetched.description).toEqual("alchemy-test-backup");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.sourceFileShare).toEqual("share1");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const nfs = yield* GCP.Filestore.Instance("Nfs", {
            instanceId: created.nfs.instanceId,
            location: CAPACITY_ZONE,
            tier: "BASIC_HDD",
            fileShares: [{ name: "share1", capacityGb: 1024 }],
            networks: [{ network: "default", modes: ["MODE_IPV4"] }],
            labels: { env: "test" },
          });
          const backup = yield* GCP.Filestore.Backup("Nightly", {
            sourceInstance: nfs.name,
            sourceFileShare: "share1",
            backupId: created.backup.backupId,
            location: CAPACITY_REGION,
            description: "alchemy-prod-backup",
            labels: { env: "prod", role: "backup" },
          });
          return { nfs, backup };
        }),
      );

      expect(updated.backup.name).toEqual(created.backup.name);
      expect(updated.backup.description).toEqual("alchemy-prod-backup");
      expect(updated.backup.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const refetched = yield* file.getProjectsLocationsBackups({
        name: created.backup.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-backup");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.backup.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:filestore", "live"],
    timeout: 2_700_000,
    retry: 0,
  },
);
