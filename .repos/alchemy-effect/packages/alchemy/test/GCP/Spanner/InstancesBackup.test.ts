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

const runLifecycle = !process.env.FAST;

const expireInDays = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const waitUntilGone = (name: string) =>
  spanner.getProjectsInstancesBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesBackups on a missing backup fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        spanner.getProjectsInstancesBackups({
          name: `projects/${project}/instances/alchemy-spanner-missing/backups/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a spanner backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const firstExpire = expireInDays(8);
      const secondExpire = expireInDays(14);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-bk-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
          });
          const backup = yield* GCP.Spanner.InstancesBackup("Nightly", {
            instance: instance.instanceId,
            database: database.databaseId,
            expireTime: firstExpire,
          });
          return { instance, database, backup };
        }),
      );

      expect(created.backup.name).toContain("/backups/");
      expect(created.backup.backupId).toEqual(expect.any(String));
      expect(created.backup.instanceId).toEqual(created.instance.instanceId);
      expect(created.backup.database).toEqual(created.database.name);
      expect(["CREATING", "READY"]).toContain(created.backup.state);

      const fetched = yield* spanner.getProjectsInstancesBackups({
        name: created.backup.name,
      });
      expect(fetched.name).toEqual(created.backup.name);
      expect(fetched.database).toEqual(created.database.name);
      expect(["CREATING", "READY"]).toContain(fetched.state);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            instanceId: created.instance.instanceId,
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-bk-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
            databaseId: created.database.databaseId,
          });
          const backup = yield* GCP.Spanner.InstancesBackup("Nightly", {
            instance: instance.instanceId,
            database: database.databaseId,
            backupId: created.backup.backupId,
            expireTime: secondExpire,
          });
          return { instance, database, backup };
        }),
      );

      expect(updated.backup.name).toEqual(created.backup.name);
      expect(updated.backup.expireTime).toEqual(expect.any(String));

      const refetched = yield* spanner.getProjectsInstancesBackups({
        name: created.backup.name,
      });
      expect(refetched.name).toEqual(created.backup.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.backup.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 180_000 },
);
