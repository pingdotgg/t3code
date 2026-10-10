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

const waitUntilGone = (name: string) =>
  spanner.getProjectsInstancesDatabasesBackupSchedules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesDatabasesBackupSchedules on a missing schedule fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        spanner.getProjectsInstancesDatabasesBackupSchedules({
          name: `projects/${project}/instances/alchemy-spanner-missing/databases/alchemy-missing/backupSchedules/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a spanner backup schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-sch-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
          });
          const schedule = yield* GCP.Spanner.InstancesDatabasesBackupSchedule(
            "Nightly",
            {
              instance: instance.instanceId,
              database: database.databaseId,
              spec: { cron: "0 2 * * *" },
              retentionDuration: "604800s",
            },
          );
          return { instance, database, schedule };
        }),
      );

      expect(created.schedule.name).toContain("/backupSchedules/");
      expect(created.schedule.backupScheduleId).toEqual(expect.any(String));
      expect(created.schedule.instanceId).toEqual(created.instance.instanceId);
      expect(created.schedule.databaseId).toEqual(created.database.databaseId);
      expect(created.schedule.cron).toEqual("0 2 * * *");
      expect(created.schedule.retentionDuration).toEqual("604800s");
      expect(created.schedule.incremental).toEqual(false);

      const fetched =
        yield* spanner.getProjectsInstancesDatabasesBackupSchedules({
          name: created.schedule.name,
        });
      expect(fetched.name).toEqual(created.schedule.name);
      expect(fetched.spec?.cronSpec?.text).toEqual("0 2 * * *");
      expect(fetched.retentionDuration).toEqual("604800s");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            instanceId: created.instance.instanceId,
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-sch-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
            databaseId: created.database.databaseId,
          });
          const schedule = yield* GCP.Spanner.InstancesDatabasesBackupSchedule(
            "Nightly",
            {
              instance: instance.instanceId,
              database: database.databaseId,
              backupScheduleId: created.schedule.backupScheduleId,
              spec: { cron: "0 14 * * *" },
              retentionDuration: "1209600s",
            },
          );
          return { instance, database, schedule };
        }),
      );

      expect(updated.schedule.name).toEqual(created.schedule.name);
      expect(updated.schedule.cron).toEqual("0 14 * * *");
      expect(updated.schedule.retentionDuration).toEqual("1209600s");

      const refetched =
        yield* spanner.getProjectsInstancesDatabasesBackupSchedules({
          name: created.schedule.name,
        });
      expect(refetched.spec?.cronSpec?.text).toEqual("0 14 * * *");
      expect(refetched.retentionDuration).toEqual("1209600s");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.schedule.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 180_000 },
);
