import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { InsightRuleResource } from "./binding-common.ts";

type InsightRules = [InsightRuleResource, ...InsightRuleResource[]];

/**
 * Runtime binding for `cloudwatch:DisableInsightRules` — pause data
 * collection for the bound Contributor Insights rules. Bind it to one or
 * more {@link InsightRule} resources; the rule names are injected
 * automatically.
 *
 * Provide `CloudWatch.DisableInsightRulesHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managing Insight Rules
 * @example Pause a Contributor Insights Rule
 * ```typescript
 * // init — grants cloudwatch:DisableInsightRules on the rule
 * const disableInsightRules = yield* AWS.CloudWatch.DisableInsightRules(rule);
 *
 * // runtime
 * const result = yield* disableInsightRules();
 * const failures = result.Failures ?? []; // empty on success
 * ```
 */
export interface DisableInsightRules extends Binding.Service<
  DisableInsightRules,
  "AWS.CloudWatch.DisableInsightRules",
  (
    ...rules: InsightRules
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.DisableInsightRulesOutput, any>
  >
> {}

export const DisableInsightRules = Binding.Service<DisableInsightRules>(
  "AWS.CloudWatch.DisableInsightRules",
);
