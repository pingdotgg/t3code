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

const waitUntilMachineGone = (appName: string, machineId: string) =>
  machines
    .getMachine({
      app_name: appName,
      machine_id: machineId,
    })
    .pipe(
      Effect.map((machine) =>
        machine.state === "destroyed" ? ("gone" as const) : ("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "create, extend, and delete a mounted disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Box", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            mounts: [{ path: "/data", sizeGb: 1, encrypted: true }],
          });
        }),
      );

      expect(created.mounts).toHaveLength(1);
      expect(created.mounts[0]?.path).toEqual("/data");
      expect(created.mounts[0]?.volumeId).toEqual(expect.any(String));
      expect(created.mounts[0]?.sizeGb).toEqual(1);
      expect(created.mounts[0]?.name).toMatch(/^[a-z][a-z0-9_]*$/);

      const fetched = yield* machines.getVolumeById({
        app_name: created.appName,
        volume_id: created.mounts[0]!.volumeId,
      });
      expect(fetched.id).toEqual(created.mounts[0]?.volumeId);
      expect(fetched.name).toEqual(created.mounts[0]?.name);
      expect(fetched.region).toEqual("iad");
      expect(fetched.size_gb).toEqual(1);
      expect(fetched.encrypted).toEqual(true);
      expect(fetched.attached_machine_id).toEqual(created.machineId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Site");
          return yield* Fly.Machine("Box", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            mounts: [
              {
                path: "/data",
                sizeGb: 2,
                encrypted: true,
                autoBackupEnabled: false,
                snapshotRetention: 2,
              },
            ],
          });
        }),
      );

      expect(updated.machineId).toEqual(created.machineId);
      expect(updated.mounts[0]?.volumeId).toEqual(created.mounts[0]?.volumeId);
      expect(updated.mounts[0]?.sizeGb).toEqual(2);

      const refetched = yield* machines.getVolumeById({
        app_name: updated.appName,
        volume_id: updated.mounts[0]!.volumeId,
      });
      expect(refetched.id).toEqual(created.mounts[0]?.volumeId);
      expect(refetched.size_gb).toEqual(2);
      expect(refetched.auto_backup_enabled).toEqual(false);
      expect(refetched.snapshot_retention).toEqual(2);

      yield* stack.destroy();

      const volumeGone = yield* waitUntilVolumeGone(
        created.appName,
        created.mounts[0]!.volumeId,
      );
      expect(volumeGone).toEqual("gone");
      const machineGone = yield* waitUntilMachineGone(
        created.appName,
        created.machineId,
      );
      expect(machineGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "replace disks when the machine region changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Machine("ReplaceBox", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            mounts: [{ path: "/data", sizeGb: 1 }],
          });
        }),
      );

      expect(created.region).toEqual("iad");
      const oldVolumeId = created.mounts[0]!.volumeId;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ReplaceSite");
          return yield* Fly.Machine("ReplaceBox", {
            app,
            region: "ewr",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            mounts: [{ path: "/data", sizeGb: 1 }],
          });
        }),
      );

      expect(replaced.machineId).not.toEqual(created.machineId);
      expect(replaced.region).toEqual("ewr");
      expect(replaced.mounts[0]?.volumeId).not.toEqual(oldVolumeId);
      expect(replaced.mounts[0]?.sizeGb).toEqual(1);

      const fetched = yield* machines.getVolumeById({
        app_name: replaced.appName,
        volume_id: replaced.mounts[0]!.volumeId,
      });
      expect(fetched.id).toEqual(replaced.mounts[0]?.volumeId);
      expect(fetched.region).toEqual("ewr");

      const oldGone = yield* waitUntilVolumeGone(created.appName, oldVolumeId);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilVolumeGone(
        replaced.appName,
        replaced.mounts[0]!.volumeId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "count creates one volume per replica",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("CountSite");
          return yield* Fly.Machine("CountBox", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            count: 2,
            mounts: [{ path: "/data", sizeGb: 1 }],
          });
        }),
      );

      expect(created.count).toEqual(2);
      expect(created.machineIds).toHaveLength(2);
      expect(created.machineIds[0]).toEqual(created.machineId);
      expect(created.replicas).toHaveLength(2);
      expect(created.replicas[0]?.mounts[0]?.volumeId).toEqual(
        expect.any(String),
      );
      expect(created.replicas[1]?.mounts[0]?.volumeId).toEqual(
        expect.any(String),
      );
      expect(created.replicas[0]?.mounts[0]?.volumeId).not.toEqual(
        created.replicas[1]?.mounts[0]?.volumeId,
      );
      expect(created.replicas[0]?.mounts[0]?.name).toEqual(
        created.replicas[1]?.mounts[0]?.name,
      );

      const left = yield* machines.getVolumeById({
        app_name: created.appName,
        volume_id: created.replicas[0]!.mounts[0]!.volumeId,
      });
      const right = yield* machines.getVolumeById({
        app_name: created.appName,
        volume_id: created.replicas[1]!.mounts[0]!.volumeId,
      });
      expect(left.attached_machine_id).toEqual(created.replicas[0]?.machineId);
      expect(right.attached_machine_id).toEqual(created.replicas[1]?.machineId);
      expect(left.name).toEqual(right.name);

      const scaled = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("CountSite");
          return yield* Fly.Machine("CountBox", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            count: 1,
            mounts: [{ path: "/data", sizeGb: 1 }],
          });
        }),
      );

      expect(scaled.count).toEqual(1);
      expect(scaled.machineIds).toEqual([created.machineId]);
      expect(scaled.mounts[0]?.volumeId).toEqual(
        created.replicas[0]?.mounts[0]?.volumeId,
      );

      const extraGone = yield* waitUntilMachineGone(
        created.appName,
        created.replicas[1]!.machineId,
      );
      expect(extraGone).toEqual("gone");
      const extraVolumeGone = yield* waitUntilVolumeGone(
        created.appName,
        created.replicas[1]!.mounts[0]!.volumeId,
      );
      expect(extraVolumeGone).toEqual("gone");

      const provider = yield* Provider.findProvider(Fly.Machine);
      const all = yield* provider.list();
      const found = all.find(
        (machine) => machine.machineId === scaled.machineId,
      );
      expect(found).toBeDefined();
      expect(found?.count).toEqual(1);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
