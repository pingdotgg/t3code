import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

test.provider(
  "getProjectsDatabasesBackupSchedules on a missing schedule fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.getProjectsDatabasesBackupSchedules({
          name: `projects/${project}/databases/alchemy-missing-xxxx/backupSchedules/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firestore", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a firestore backup schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("App", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          const schedule = yield* GCP.Firestore.DatabasesBackupSchedule(
            "Nightly",
            {
              database: database.name,
              retention: "604800s",
              dailyRecurrence: true,
            },
          );
          return { database, schedule };
        }),
      );

      expect(created.schedule.name).toContain("/backupSchedules/");
      expect(created.schedule.databaseId).toEqual(created.database.databaseId);
      expect(created.schedule.dailyRecurrence).toEqual(true);
      expect(created.schedule.retention).toEqual("604800s");

      const fetched = yield* firestore.getProjectsDatabasesBackupSchedules({
        name: created.schedule.name,
      });
      expect(fetched.name).toEqual(created.schedule.name);
      expect(fetched.retention).toEqual("604800s");
      expect(fetched.dailyRecurrence).toEqual(expect.anything());

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("App", {
            databaseId: created.database.databaseId,
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          const schedule = yield* GCP.Firestore.DatabasesBackupSchedule(
            "Nightly",
            {
              database: database.name,
              retention: "1209600s",
              dailyRecurrence: true,
            },
          );
          return { database, schedule };
        }),
      );

      expect(updated.schedule.name).toEqual(created.schedule.name);
      expect(updated.schedule.retention).toEqual("1209600s");

      const refetched = yield* firestore.getProjectsDatabasesBackupSchedules({
        name: created.schedule.name,
      });
      expect(refetched.retention).toEqual("1209600s");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firestore", "live"],
    timeout: 180_000,
  },
);
