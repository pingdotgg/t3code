import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
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
  cci.getProjectsLocationsDashboardsCharts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDashboardsCharts on a missing chart fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsDashboardsCharts({
          name: `projects/${project}/locations/us-central1/dashboards/missing/charts/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);

// The testing project rejects every dashboard create with BadRequest
// "Request contains an invalid argument." Set GCP_TEST_CCI_DASHBOARDS=1 on
// a project where CCI dashboards are available.
test.provider.skipIf(
  !!process.env.FAST || !process.env.GCP_TEST_CCI_DASHBOARDS,
)(
  "create, update, and delete a dashboard chart",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dashboard = yield* GCP.ContactCenterInsights.Dashboard(
            "Board",
            {
              location: "us-central1",
              displayName: "chart-board",
            },
          );
          return yield* GCP.ContactCenterInsights.DashboardsChart("Volume", {
            parent: dashboard.name,
            displayName: "volume",
            description: "call volume",
            chartVisualizationType: "BAR",
            width: 2,
            height: 2,
          });
        }),
      );

      expect(created.name).toContain("/charts/");
      expect(created.displayName).toEqual("volume");
      expect(created.description).toEqual("call volume");

      const fetched = yield* cci.getProjectsLocationsDashboardsCharts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dashboard = yield* GCP.ContactCenterInsights.Dashboard(
            "Board",
            {
              location: "us-central1",
              displayName: "chart-board",
            },
          );
          return yield* GCP.ContactCenterInsights.DashboardsChart("Volume", {
            parent: dashboard.name,
            chartId: created.chartId,
            displayName: "volume-v2",
            description: "updated volume",
            chartVisualizationType: "LINE",
            width: 3,
            height: 2,
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("volume-v2");
      expect(updated.description).toEqual("updated volume");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:contactcenterinsights", "live"],
    timeout: 90_000,
  },
);
