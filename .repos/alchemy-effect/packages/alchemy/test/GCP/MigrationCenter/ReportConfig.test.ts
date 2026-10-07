import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as migrationcenter from "@distilled.cloud/gcp/migrationcenter_v1";
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
  migrationcenter.getProjectsLocationsReportConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsReportConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsReportConfigs({
          name: `projects/${project}/locations/us-central1/reportConfigs/alchemy-missing-config`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create and delete a migration center report config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.MigrationCenter.Group("Workloads", {
            location: "us-central1",
            displayName: "tco-group",
          });
          const prefs = yield* GCP.MigrationCenter.PreferenceSet("Prod", {
            location: "us-central1",
            displayName: "tco-prefs",
          });
          const config = yield* GCP.MigrationCenter.ReportConfig("Tco", {
            location: "us-central1",
            displayName: "tco",
            description: "quarterly tco",
            groupPreferencesetAssignments: [
              { group: group.name, preferenceSet: prefs.name },
            ],
          });
          return { group, prefs, config };
        }),
      );

      expect(created.config.reportConfigId).toEqual(expect.any(String));
      expect(created.config.displayName).toEqual("tco");
      expect(created.config.description).toEqual("quarterly tco");
      expect(created.config.groupPreferencesetAssignments).toHaveLength(1);
      expect(created.config.groupPreferencesetAssignments[0]?.group).toEqual(
        created.group.name,
      );
      expect(
        created.config.groupPreferencesetAssignments[0]?.preferenceSet,
      ).toEqual(created.prefs.name);

      const fetched = yield* migrationcenter.getProjectsLocationsReportConfigs({
        name: created.config.name,
      });
      expect(fetched.name).toEqual(created.config.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("quarterly tco");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.MigrationCenter.Group("Workloads", {
            groupId: created.group.groupId,
            location: "us-central1",
            displayName: "tco-group",
          });
          const prefs = yield* GCP.MigrationCenter.PreferenceSet("Prod", {
            preferenceSetId: created.prefs.preferenceSetId,
            location: "us-central1",
            displayName: "tco-prefs",
          });
          const config = yield* GCP.MigrationCenter.ReportConfig("Tco", {
            reportConfigId: created.config.reportConfigId,
            location: "us-central1",
            displayName: "tco-v2",
            description: "quarterly tco v2",
            groupPreferencesetAssignments: [
              { group: group.name, preferenceSet: prefs.name },
            ],
          });
          return { group, prefs, config };
        }),
      );

      expect(updated.config.reportConfigId).toEqual(
        created.config.reportConfigId,
      );
      expect(updated.config.displayName).toEqual("tco-v2");
      expect(updated.config.description).toEqual("quarterly tco v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(updated.config.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 120_000,
  },
);
