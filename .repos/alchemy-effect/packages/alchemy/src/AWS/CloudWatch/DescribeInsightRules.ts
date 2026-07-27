import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeInsightRulesRequest
  extends cloudwatch.DescribeInsightRulesInput {}

/**
 * Runtime binding for `cloudwatch:DescribeInsightRules` — list the
 * Contributor Insights rules in the account/region.
 *
 * Provide `CloudWatch.DescribeInsightRulesHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Insight Rules
 * @example List Contributor Insights Rules
 * ```typescript
 * // init — grants cloudwatch:DescribeInsightRules
 * const describeInsightRules = yield* AWS.CloudWatch.DescribeInsightRules();
 *
 * // runtime
 * const result = yield* describeInsightRules();
 * const names = (result.InsightRules ?? []).map((rule) => rule.Name);
 * ```
 */
export interface DescribeInsightRules extends Binding.Service<
  DescribeInsightRules,
  "AWS.CloudWatch.DescribeInsightRules",
  () => Effect.Effect<
    (
      request?: DescribeInsightRulesRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeInsightRulesOutput,
      cloudwatch.DescribeInsightRulesError
    >
  >
> {}

export const DescribeInsightRules = Binding.Service<DescribeInsightRules>(
  "AWS.CloudWatch.DescribeInsightRules",
);
