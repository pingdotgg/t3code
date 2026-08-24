import * as AWS from "@/AWS";
import { Dashboard } from "@/AWS/CloudWatch/Dashboard.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// real dashboard, resolve the provider from context via `findProvider`, call
// `list()`, and assert the deployed dashboard appears in the exhaustively-
// paginated result.
test.provider("list enumerates the deployed dashboard", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const dashboard = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Dashboard("ListDashboard", {
          name: "alchemy-test-dashboard-list",
          DashboardBody: {
            widgets: [
              {
                type: "text",
                x: 0,
                y: 0,
                width: 6,
                height: 3,
                properties: { markdown: "# list test" },
              },
            ],
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(Dashboard);
    const all = yield* provider.list();

    expect(all.some((d) => d.dashboardName === dashboard.dashboardName)).toBe(
      true,
    );

    yield* stack.destroy();

    // Out-of-band assert-gone: getDashboard returns the typed
    // DashboardNotFoundError once the dashboard is deleted.
    const gone = yield* cloudwatch
      .getDashboard({ DashboardName: dashboard.dashboardName })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("DashboardNotFoundError", () => Effect.succeed(true)),
      );
    expect(gone).toBe(true);
  }),
);
