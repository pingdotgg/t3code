import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InsightRuleResource } from "./binding-common.ts";

type InsightRules = [InsightRuleResource, ...InsightRuleResource[]];

/**
 * Runtime binding for `cloudwatch:EnableInsightRules` — resume data
 * collection for the bound Contributor Insights rules after they were
 * paused with {@link DisableInsightRules}. Bind it to one or more
 * {@link InsightRule} resources; the rule names are injected automatically.
 *
 * Provide `CloudWatch.EnableInsightRulesHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managing Insight Rules
 * @example Resume a Contributor Insights Rule
 * ```typescript
 * // init — grants cloudwatch:EnableInsightRules on the rule
 * const enableInsightRules = yield* AWS.CloudWatch.EnableInsightRules(rule);
 *
 * // runtime
 * const result = yield* enableInsightRules();
 * const failures = result.Failures ?? []; // empty on success
 * ```
 */
export interface EnableInsightRules extends Binding.Service<
  EnableInsightRules,
  "AWS.CloudWatch.EnableInsightRules",
  (
    ...rules: InsightRules
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.EnableInsightRulesOutput, any>
  >
> {}

export const EnableInsightRules = Binding.Service<EnableInsightRules>(
  "AWS.CloudWatch.EnableInsightRules",
);
