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

const zone = "us-central1-a";

const waitUntilGone = (
  project: string,
  zoneName: string,
  instantSnapshot: string,
) =>
  compute
    .getInstantSnapshots({ project, zone: zoneName, instantSnapshot })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!!process.env.FAST)(
  "create, update labels, replace, and delete an instant snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.Disk("Data", {
            zone,
            type: "pd-balanced",
            sizeGb: 10,
          });
          const snapshot = yield* GCP.Compute.InstantSnapshot("Checkpoint", {
            zone,
            sourceDisk: disk.selfLink.as<string>(),
            description: "first checkpoint",
            labels: { env: "test" },
          });
          return { disk, snapshot };
        }),
      );

      expect(created.snapshot.instantSnapshotName).toEqual(expect.any(String));
      expect(created.snapshot.zone).toEqual(zone);
      expect(created.snapshot.status).toEqual("READY");
      expect(created.snapshot.labels).toMatchObject({ env: "test" });
      expect(created.snapshot.description).toEqual("first checkpoint");

      const fetched = yield* compute.getInstantSnapshots({
        project: created.snapshot.project,
        zone,
        instantSnapshot: created.snapshot.instantSnapshotName,
      });
      expect(fetched.name).toEqual(created.snapshot.instantSnapshotName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.status).toEqual("READY");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const disk = yield* GCP.Compute.Disk("Data", {
            diskName: created.disk.diskName,
            zone,
            type: "pd-balanced",
            sizeGb: 10,
          });
          const snapshot = yield* GCP.Compute.InstantSnapshot("Checkpoint", {
            instantSnapshotName: created.snapshot.instantSnapshotName,
            zone,
            sourceDisk: disk.selfLink.as<string>(),
            description: "first checkpoint",
            labels: { env: "prod", role: "data" },
          });
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
          const disk = yield* GCP.Compute.Disk("Data", {
            diskName: created.disk.diskName,
            zone,
            type: "pd-balanced",
            sizeGb: 10,
          });
          const snapshot = yield* GCP.Compute.InstantSnapshot("Checkpoint", {
            instantSnapshotName: nextName,
            zone,
            sourceDisk: disk.selfLink.as<string>(),
            description: "replaced checkpoint",
          });
          return { disk, snapshot };
        }),
      );

      expect(replaced.snapshot.instantSnapshotName).toEqual(nextName);
      expect(replaced.snapshot.description).toEqual("replaced checkpoint");

      const oldGone = yield* waitUntilGone(
        created.snapshot.project,
        zone,
        created.snapshot.instantSnapshotName,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.snapshot.project,
        zone,
        replaced.snapshot.instantSnapshotName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
