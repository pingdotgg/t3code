import type * as cur from "@distilled.cloud/aws/cost-and-usage-report-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link DescribeReportDefinitions} — pagination knobs only.
 */
export interface DescribeReportDefinitionsRequest
  extends cur.DescribeReportDefinitionsRequest {}

/**
 * Runtime binding for `cur:DescribeReportDefinitions`.
 *
 * Lists the Cost and Usage Report definitions in the account — each entry
 * carries the report's delivery bucket/prefix, granularity, format, and last
 * delivery status, so a Lambda can discover where its billing data lands
 * before reading the report files from S3. Account-level operation (the API
 * enumerates every definition), so the binding takes no resource argument.
 * Provide the implementation with
 * `Effect.provide(AWS.CostAndUsageReport.DescribeReportDefinitionsHttp)`.
 * @binding
 * @section Reading Report Definitions
 * @example Find a report's delivery location
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeReportDefinitions =
 *   yield* AWS.CostAndUsageReport.DescribeReportDefinitions();
 *
 * // runtime
 * const { ReportDefinitions } = yield* describeReportDefinitions();
 * const report = ReportDefinitions?.find((r) => r.ReportName === "costs");
 * yield* Effect.log(`delivered to s3://${report?.S3Bucket}/${report?.S3Prefix}`);
 * ```
 */
export interface DescribeReportDefinitions extends Binding.Service<
  DescribeReportDefinitions,
  "AWS.CostAndUsageReport.DescribeReportDefinitions",
  () => Effect.Effect<
    (
      request?: DescribeReportDefinitionsRequest,
    ) => Effect.Effect<
      cur.DescribeReportDefinitionsResponse,
      cur.DescribeReportDefinitionsError
    >
  >
> {}

export const DescribeReportDefinitions =
  Binding.Service<DescribeReportDefinitions>(
    "AWS.CostAndUsageReport.DescribeReportDefinitions",
  );
