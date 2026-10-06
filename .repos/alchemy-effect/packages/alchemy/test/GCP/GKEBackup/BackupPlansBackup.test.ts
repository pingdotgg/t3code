import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkebackup from "@distilled.cloud/gcp/gkebackup_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "getProjectsLocationsBackupPlansBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkebackup.getProjectsLocationsBackupPlansBackups({
          name: `projects/${project}/locations/us-central1/backupPlans/alchemy-missing-plan/backups/alchemy-missing-backup`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* gkebackup.listProjectsLocationsBackupPlansBackups({
        parent: `projects/${project}/locations/-/backupPlans/-`,
        pageSize: 10,
      });
      expect((page.backups ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/backupPlans/alchemy-missing-plan/backups/alchemy-missing-backup`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkebackup", "live"], timeout: 90_000 },
);

test.provider(
  "create against a missing backup plan is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.GKEBackup.BackupPlansBackup("Snapshot", {
              backupPlan: `projects/${project}/locations/us-central1/backupPlans/alchemy-missing-plan`,
              description: "alchemy-test-backup",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkebackup", "live"], timeout: 90_000 },
);
