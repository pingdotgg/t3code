import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Dashboard } from "./Dashboard.ts";

export interface GetDashboardRequest extends Omit<
  cloudwatch.GetDashboardInput,
  "DashboardName"
> {}

/**
 * Runtime binding for `cloudwatch:GetDashboard`.
 */
export class GetDashboard extends Binding.Service<
  GetDashboard,
  (
    dashboard: Dashboard,
  ) => Effect.Effect<
    (
      request?: GetDashboardRequest,
    ) => Effect.Effect<
      cloudwatch.GetDashboardOutput,
      cloudwatch.GetDashboardError
    >
  >
>()("AWS.CloudWatch.GetDashboard") {}

export const GetDashboardLive = Layer.effect(
  GetDashboard,
  Effect.gen(function* () {
    const Policy = yield* GetDashboardPolicy;
    const getDashboard = yield* cloudwatch.getDashboard;

    return Effect.fn(function* (dashboard: Dashboard) {
      const DashboardName = yield* dashboard.dashboardName;
      yield* Policy(dashboard);

      return Effect.fn(function* (request: GetDashboardRequest = {}) {
        return yield* getDashboard({
          ...request,
          DashboardName: yield* DashboardName,
        });
      });
    });
  }),
);

export class GetDashboardPolicy extends Binding.Policy<
  GetDashboardPolicy,
  (dashboard: Dashboard) => Effect.Effect<void>
>()("AWS.CloudWatch.GetDashboard") {}

export const GetDashboardPolicyLive = GetDashboardPolicy.layer.succeed(
  Effect.fn(function* (host, dashboard) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.CloudWatch.GetDashboard(${dashboard}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudwatch:GetDashboard"],
              Resource: [dashboard.dashboardArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `GetDashboardPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
