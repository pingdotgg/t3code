import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsBackupPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBackupPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsBackupPolicies({
          name: `projects/${project}/locations/us-central1/backupPolicies/alchemy-netapp-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a backup policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.BackupPolicy("Nightly", {
            location: "us-central1",
            dailyBackupLimit: 2,
            weeklyBackupLimit: 1,
            monthlyBackupLimit: 1,
            description: "alchemy nightly backups",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/backupPolicies/");
      expect(created.dailyBackupLimit).toEqual(2);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsBackupPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.BackupPolicy("Nightly", {
            backupPolicyId: created.backupPolicyId,
            location: "us-central1",
            dailyBackupLimit: 3,
            weeklyBackupLimit: 2,
            monthlyBackupLimit: 1,
            description: "updated alchemy nightly backups",
            labels: { env: "prod", role: "backup" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.dailyBackupLimit).toEqual(3);
      expect(updated.labels).toMatchObject({ env: "prod", role: "backup" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 180_000 },
);
