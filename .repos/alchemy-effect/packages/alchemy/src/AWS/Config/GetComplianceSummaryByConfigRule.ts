import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:GetComplianceSummaryByConfigRule` — read the
 * account-wide count of compliant vs. noncompliant Config rules.
 *
 * Provide `Config.GetComplianceSummaryByConfigRuleHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Compliance
 * @example Summarize Rule Compliance
 * ```typescript
 * // init — grants config:GetComplianceSummaryByConfigRule
 * const getComplianceSummaryByConfigRule = yield* AWS.Config.GetComplianceSummaryByConfigRule();
 *
 * // runtime
 * const result = yield* getComplianceSummaryByConfigRule();
 * console.log(result.ComplianceSummary?.NonCompliantResourceCount);
 * ```
 */
export interface GetComplianceSummaryByConfigRule extends Binding.Service<
  GetComplianceSummaryByConfigRule,
  "AWS.Config.GetComplianceSummaryByConfigRule",
  () => Effect.Effect<
    (
      request?: config.GetComplianceSummaryByConfigRuleRequest,
    ) => Effect.Effect<
      config.GetComplianceSummaryByConfigRuleResponse,
      config.GetComplianceSummaryByConfigRuleError
    >
  >
> {}

export const GetComplianceSummaryByConfigRule =
  Binding.Service<GetComplianceSummaryByConfigRule>(
    "AWS.Config.GetComplianceSummaryByConfigRule",
  );
