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
  migrationcenter.getProjectsLocationsReportConfigsReports({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsReportConfigsReports on a missing report fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsReportConfigsReports({
          name: `projects/${project}/locations/us-central1/reportConfigs/alchemy-missing-config/reports/alchemy-missing-report`,
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

test.provider.skipIf(!!process.env.FAST)(
  "create and delete a migration center report",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.MigrationCenter.Group("Workloads", {
            location: "us-central1",
            displayName: "report-group",
          });
          const prefs = yield* GCP.MigrationCenter.PreferenceSet("Prod", {
            location: "us-central1",
            displayName: "report-prefs",
          });
          const config = yield* GCP.MigrationCenter.ReportConfig("Tco", {
            location: "us-central1",
            displayName: "report-config",
            groupPreferencesetAssignments: [
              { group: group.name, preferenceSet: prefs.name },
            ],
          });
          const report = yield* GCP.MigrationCenter.ReportConfigsReport(
            "Quarter",
            {
              reportConfig: config.name,
              location: "us-central1",
              type: "TOTAL_COST_OF_OWNERSHIP",
              displayName: "q1-tco",
              description: "first quarter",
            },
          );
          return { group, prefs, config, report };
        }),
      );

      expect(created.report.reportId).toEqual(expect.any(String));
      expect(created.report.reportConfig).toEqual(created.config.name);
      expect(created.report.type).toEqual("TOTAL_COST_OF_OWNERSHIP");
      expect(created.report.displayName).toEqual("q1-tco");
      expect(created.report.description).toEqual("first quarter");

      const fetched =
        yield* migrationcenter.getProjectsLocationsReportConfigsReports({
          name: created.report.name,
          view: "REPORT_VIEW_BASIC",
        });
      expect(fetched.name).toEqual(created.report.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("first quarter");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.report.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 120_000,
  },
);
