import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const dailyRule = {
  ruleId: "daily",
  backupRetentionDays: 1,
  standardSchedule: {
    recurrenceType: "DAILY" as const,
    timeZone: "UTC",
    backupWindow: { startHourOfDay: 1, endHourOfDay: 5 },
  },
};

test.provider(
  "getProjectsLocationsBackupPlanAssociations on a missing association fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        backupdr.getProjectsLocationsBackupPlanAssociations({
          name: `projects/${project}/locations/us-central1/backupPlanAssociations/alchemy-backupdr-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* backupdr.listProjectsLocationsBackupPlanAssociations({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect(
        (page.backupPlanAssociations ?? []).map((item) => item.name),
      ).not.toContain(
        `projects/${project}/locations/us-central1/backupPlanAssociations/alchemy-backupdr-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:backupdr", "live"], timeout: 90_000 },
);

test.provider(
  "create against a missing plan is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.BackupDR.BackupPlanAssociation("VmPlan", {
              resource: `projects/${project}/zones/us-central1-a/instances/alchemy-backupdr-missing`,
              resourceType: "compute.googleapis.com/Instance",
              backupPlan: `projects/${project}/locations/us-central1/backupPlans/alchemy-backupdr-missing`,
            });
          }),
        ),
      );
      expect(error._tag).toEqual("BackupPlanReferenceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:backupdr", "live"], timeout: 90_000 },
);

test.provider(
  "create against a missing compute instance is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            const vault = yield* GCP.BackupDR.BackupVault("Vault", {
              backupMinimumEnforcedRetentionDuration: "86400s",
              description: "alchemy-test-bpa-vault",
              labels: { env: "test" },
            });
            const plan = yield* GCP.BackupDR.BackupPlan("Nightly", {
              backupVault: vault.name,
              resourceType: "compute.googleapis.com/Instance",
              backupRules: [dailyRule],
              description: "alchemy-test-bpa-plan",
              labels: { env: "test" },
            });
            return yield* GCP.BackupDR.BackupPlanAssociation("VmPlan", {
              resource: `projects/${project}/zones/us-central1-a/instances/alchemy-backupdr-missing`,
              resourceType: "compute.googleapis.com/Instance",
              backupPlan: plan.name,
            });
          }),
        ),
      );
      expect(error._tag).toEqual("BackupResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:backupdr", "live"], timeout: 300_000 },
);
