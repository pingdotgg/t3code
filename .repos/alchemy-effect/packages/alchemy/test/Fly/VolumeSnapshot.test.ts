import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilVolumeGone = (appName: string, volumeId: string) =>
  machines
    .getVolumeById({
      app_name: appName,
      volume_id: volumeId,
    })
    .pipe(
      Effect.map((volume) => {
        const state = volume.state;
        return state === "destroyed" ||
          state === "pending_destroy" ||
          state === "scheduled_for_destruction"
          ? ("gone" as const)
          : ("found" as const);
      }),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitUntilAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const listedHas = (appName: string, volumeId: string, snapshotId: string) =>
  machines
    .listVolumeSnapshots({
      app_name: appName,
      volume_id: volumeId,
    })
    .pipe(
      Effect.map((snapshots) =>
        snapshots.find((snapshot) => snapshot.id === snapshotId),
      ),
    );

const box = (id: string, app: Fly.App, name: string) =>
  Fly.Machine(id, {
    app,
    name,
    region: "iad",
    image: "nginx:alpine",
    guest: { cpus: 1, memoryMb: 256 },
    mounts: [{ path: "/data", sizeGb: 1, autoBackupEnabled: false }],
  });

test.provider(
  "create, update, and destroy a volume snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapSite");
          const volume = yield* box("SnapData", app, "snap-data");
          return { app, volume };
        }),
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapSite");
          const volume = yield* box("SnapData", app, "snap-data");
          const snapshot = yield* Fly.VolumeSnapshot("Nightly", {
            app,
            volumeId: base.volume.mounts[0]!.volumeId,
          });
          return { app, volume, snapshot };
        }),
      );

      expect(created.snapshot.snapshotId).toEqual(expect.any(String));
      expect(created.snapshot.snapshotId.length).toBeGreaterThan(0);
      expect(created.snapshot.appName).toEqual(created.app.appName);
      expect(created.snapshot.volumeId).toEqual(
        created.volume.mounts[0]?.volumeId,
      );

      const fetched = yield* listedHas(
        created.app.appName,
        created.volume.mounts[0]!.volumeId,
        created.snapshot.snapshotId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.id).toEqual(created.snapshot.snapshotId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapSite");
          const volume = yield* box("SnapData", app, "snap-data");
          const snapshot = yield* Fly.VolumeSnapshot("Nightly", {
            app,
            volumeId: created.volume.mounts[0]!.volumeId,
          });
          return { app, volume, snapshot };
        }),
      );

      expect(updated.snapshot.snapshotId).toEqual(created.snapshot.snapshotId);
      expect(updated.snapshot.volumeId).toEqual(
        created.volume.mounts[0]?.volumeId,
      );
      expect(updated.snapshot.appName).toEqual(created.app.appName);

      const provider = yield* Provider.findProvider(Fly.VolumeSnapshot);
      const all = yield* provider.list();
      const listed = all.find(
        (row) => row.snapshotId === created.snapshot.snapshotId,
      );
      expect(listed).toBeDefined();
      expect(listed?.appName).toEqual(created.app.appName);
      expect(listed?.volumeId).toEqual(created.volume.mounts[0]?.volumeId);

      yield* stack.destroy();

      const volumeGone = yield* waitUntilVolumeGone(
        created.volume.appName,
        created.volume.mounts[0]!.volumeId,
      );
      expect(volumeGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "replace when the volume changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapReplaceSite");
          const volumeA = yield* box("SnapReplaceA", app, "snap-a");
          const volumeB = yield* box("SnapReplaceB", app, "snap-b");
          return { app, volumeA, volumeB };
        }),
      );

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapReplaceSite");
          const volumeA = yield* box("SnapReplaceA", app, "snap-a");
          const volumeB = yield* box("SnapReplaceB", app, "snap-b");
          const snapshot = yield* Fly.VolumeSnapshot("Retarget", {
            app,
            volumeId: base.volumeA.mounts[0]!.volumeId,
          });
          return { app, volumeA, volumeB, snapshot };
        }),
      );

      expect(created.snapshot.volumeId).toEqual(
        created.volumeA.mounts[0]?.volumeId,
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("SnapReplaceSite");
          const volumeA = yield* box("SnapReplaceA", app, "snap-a");
          const volumeB = yield* box("SnapReplaceB", app, "snap-b");
          const snapshot = yield* Fly.VolumeSnapshot("Retarget", {
            app,
            volumeId: created.volumeB.mounts[0]!.volumeId,
          });
          return { app, volumeA, volumeB, snapshot };
        }),
      );

      expect(replaced.snapshot.snapshotId).not.toEqual(
        created.snapshot.snapshotId,
      );
      expect(replaced.snapshot.volumeId).toEqual(
        replaced.volumeB.mounts[0]?.volumeId,
      );
      expect(replaced.snapshot.volumeId).not.toEqual(
        created.volumeA.mounts[0]?.volumeId,
      );
      expect(replaced.snapshot.appName).toEqual(created.app.appName);

      const fetched = yield* listedHas(
        replaced.app.appName,
        replaced.volumeB.mounts[0]!.volumeId,
        replaced.snapshot.snapshotId,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.id).toEqual(replaced.snapshot.snapshotId);

      yield* stack.destroy();

      const oldGone = yield* waitUntilVolumeGone(
        created.volumeA.appName,
        created.volumeA.mounts[0]!.volumeId,
      );
      expect(oldGone).toEqual("gone");
      const newGone = yield* waitUntilVolumeGone(
        replaced.volumeB.appName,
        replaced.volumeB.mounts[0]!.volumeId,
      );
      expect(newGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
