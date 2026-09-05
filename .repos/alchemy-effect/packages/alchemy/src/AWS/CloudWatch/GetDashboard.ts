import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dashboard } from "./Dashboard.ts";

export interface GetDashboardRequest extends Omit<
  cloudwatch.GetDashboardInput,
  "DashboardName"
> {}

/**
 * Runtime binding for `cloudwatch:GetDashboard` — read the body and
 * metadata of the bound {@link Dashboard}; the dashboard name is injected
 * automatically.
 *
 * Provide `CloudWatch.GetDashboardHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Dashboards
 * @example Read a Bound Dashboard
 * ```typescript
 * // init — grants cloudwatch:GetDashboard on the dashboard
 * const getDashboard = yield* AWS.CloudWatch.GetDashboard(dashboard);
 *
 * // runtime
 * const result = yield* getDashboard();
 * const widgets = JSON.parse(result.DashboardBody ?? "{}").widgets;
 * ```
 */
export interface GetDashboard extends Binding.Service<
  GetDashboard,
  "AWS.CloudWatch.GetDashboard",
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
> {}

export const GetDashboard = Binding.Service<GetDashboard>(
  "AWS.CloudWatch.GetDashboard",
);
