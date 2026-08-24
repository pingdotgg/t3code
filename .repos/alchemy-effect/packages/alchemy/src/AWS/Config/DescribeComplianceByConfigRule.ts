import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:DescribeComplianceByConfigRule` — read
 * whether your Config rules are compliant (and how many resources violate
 * each noncompliant rule).
 *
 * Provide `Config.DescribeComplianceByConfigRuleHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Compliance
 * @example Check Rule Compliance
 * ```typescript
 * // init — grants config:DescribeComplianceByConfigRule
 * const describeComplianceByConfigRule = yield* AWS.Config.DescribeComplianceByConfigRule();
 *
 * // runtime
 * const result = yield* describeComplianceByConfigRule();
 * for (const rule of result.ComplianceByConfigRules ?? []) {
 *   console.log(rule.ConfigRuleName, rule.Compliance?.ComplianceType);
 * }
 * ```
 */
export interface DescribeComplianceByConfigRule extends Binding.Service<
  DescribeComplianceByConfigRule,
  "AWS.Config.DescribeComplianceByConfigRule",
  () => Effect.Effect<
    (
      request?: config.DescribeComplianceByConfigRuleRequest,
    ) => Effect.Effect<
      config.DescribeComplianceByConfigRuleResponse,
      config.DescribeComplianceByConfigRuleError
    >
  >
> {}

export const DescribeComplianceByConfigRule =
  Binding.Service<DescribeComplianceByConfigRule>(
    "AWS.Config.DescribeComplianceByConfigRule",
  );
