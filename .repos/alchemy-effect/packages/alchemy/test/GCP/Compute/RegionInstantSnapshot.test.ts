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

const waitUntilGone = (project: string, instantSnapshot: string) =>
  compute.getRegionInstantSnapshots({ project, region, instantSnapshot }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update labels, replace, and delete a regional instant snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.RegionDisk("Data", {
            region,
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "pd-balanced",
            sizeGb: 200,
          });
          const snapshot = yield* GCP.Compute.RegionInstantSnapshot(
            "Checkpoint",
            {
              region,
              sourceDisk: disk.selfLink.as<string>(),
              description: "first checkpoint",
              labels: { env: "test" },
            },
          );
          return { disk, snapshot };
        }),
      );

      expect(created.snapshot.instantSnapshotName).toEqual(expect.any(String));
      expect(created.snapshot.region).toEqual(region);
      expect(created.snapshot.status).toEqual("READY");
      expect(created.snapshot.labels).toMatchObject({ env: "test" });
      expect(created.snapshot.description).toEqual("first checkpoint");

      const fetched = yield* compute.getRegionInstantSnapshots({
        project: created.snapshot.project,
        region,
        instantSnapshot: created.snapshot.instantSnapshotName,
      });
      expect(fetched.name).toEqual(created.snapshot.instantSnapshotName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.status).toEqual("READY");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.RegionDisk("Data", {
            diskName: created.disk.diskName,
            region,
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "pd-balanced",
            sizeGb: 200,
          });
          const snapshot = yield* GCP.Compute.RegionInstantSnapshot(
            "Checkpoint",
            {
              instantSnapshotName: created.snapshot.instantSnapshotName,
              region,
              sourceDisk: disk.selfLink.as<string>(),
              description: "first checkpoint",
              labels: { env: "prod", role: "data" },
            },
          );
          return { disk, snapshot };
        }),
      );

      expect(updated.snapshot.instantSnapshotName).toEqual(
        created.snapshot.instantSnapshotName,
      );
      expect(updated.snapshot.labels).toMatchObject({
        env: "prod",
        role: "data",
      });

      const nextName = `r${created.snapshot.instantSnapshotName}`
        .slice(0, 63)
        .replace(/-+$/, "x");
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.RegionDisk("Data", {
            diskName: created.disk.diskName,
            region,
            replicaZones: ["us-central1-a", "us-central1-b"],
            type: "pd-balanced",
            sizeGb: 200,
          });
          const snapshot = yield* GCP.Compute.RegionInstantSnapshot(
            "Checkpoint",
            {
              instantSnapshotName: nextName,
              region,
              sourceDisk: disk.selfLink.as<string>(),
              description: "replaced checkpoint",
            },
          );
          return { disk, snapshot };
        }),
      );

      expect(replaced.snapshot.instantSnapshotName).toEqual(nextName);
      expect(replaced.snapshot.description).toEqual("replaced checkpoint");

      const oldGone = yield* waitUntilGone(
        created.snapshot.project,
        created.snapshot.instantSnapshotName,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.snapshot.project,
        replaced.snapshot.instantSnapshotName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
