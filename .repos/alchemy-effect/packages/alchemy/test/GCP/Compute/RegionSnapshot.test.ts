import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const region = "us-central1";

const waitUntilGone = (project: string, snapshot: string) =>
  compute.getRegionSnapshots({ project, region, snapshot }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a regional snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.RegionDisk("Data", {
            region,
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "pd-standard",
            sizeGb: 200,
          });
          const snapshot = yield* GCP.Compute.RegionSnapshot("Backup", {
            region,
            sourceDisk: disk.selfLink.as<string>(),
            labels: { env: "test" },
          });
          return { disk, snapshot };
        }),
      );

      expect(created.snapshot.snapshotName).toEqual(expect.any(String));
      expect(created.snapshot.region).toEqual(region);
      expect(created.snapshot.status).toEqual("READY");
      expect(created.snapshot.labels).toMatchObject({ env: "test" });
      expect(created.snapshot.sourceDisk).toEqual(expect.any(String));
      expect(created.snapshot.selfLink).toEqual(expect.any(String));

      const fetched = yield* compute.getRegionSnapshots({
        project: created.snapshot.project,
        region,
        snapshot: created.snapshot.snapshotName,
      });
      expect(fetched.name).toEqual(created.snapshot.snapshotName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.status).toEqual("READY");
      expect(fetched.sourceDisk).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.RegionDisk("Data", {
            diskName: created.disk.diskName,
            region,
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "pd-standard",
            sizeGb: 200,
          });
          const snapshot = yield* GCP.Compute.RegionSnapshot("Backup", {
            snapshotName: created.snapshot.snapshotName,
            region,
            sourceDisk: disk.selfLink.as<string>(),
            labels: { env: "prod", role: "backup" },
          });
          return { disk, snapshot };
        }),
      );

      expect(updated.snapshot.snapshotName).toEqual(
        created.snapshot.snapshotName,
      );
      expect(updated.snapshot.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const fetchedUpdated = yield* compute.getRegionSnapshots({
        project: updated.snapshot.project,
        region,
        snapshot: updated.snapshot.snapshotName,
      });
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.snapshot.project,
        created.snapshot.snapshotName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
