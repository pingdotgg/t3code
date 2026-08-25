import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListDashboardsRequest extends cloudwatch.ListDashboardsInput {}

/**
 * Runtime binding for `cloudwatch:ListDashboards` — list the dashboards in
 * the account, optionally filtered by name prefix.
 *
 * Provide `CloudWatch.ListDashboardsHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Reading Dashboards
 * @example List Dashboards
 * ```typescript
 * // init — grants cloudwatch:ListDashboards
 * const listDashboards = yield* AWS.CloudWatch.ListDashboards();
 *
 * // runtime
 * const result = yield* listDashboards();
 * const names = (result.DashboardEntries ?? []).map((e) => e.DashboardName);
 * ```
 */
export interface ListDashboards extends Binding.Service<
  ListDashboards,
  "AWS.CloudWatch.ListDashboards",
  () => Effect.Effect<
    (
      request?: ListDashboardsRequest,
    ) => Effect.Effect<
      cloudwatch.ListDashboardsOutput,
      cloudwatch.ListDashboardsError
    >
  >
> {}

export const ListDashboards = Binding.Service<ListDashboards>(
  "AWS.CloudWatch.ListDashboards",
);
