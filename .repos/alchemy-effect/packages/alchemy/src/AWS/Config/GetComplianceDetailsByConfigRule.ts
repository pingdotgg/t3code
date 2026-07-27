import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConfigRule } from "./ConfigRule.ts";

/** Request for {@link GetComplianceDetailsByConfigRule} — the rule name is injected from the bound rule. */
export interface GetComplianceDetailsByConfigRuleRequest extends Omit<
  config.GetComplianceDetailsByConfigRuleRequest,
  "ConfigRuleName"
> {}

/**
 * Runtime binding for `config:GetComplianceDetailsByConfigRule` — read the
 * per-resource evaluation results (who was evaluated, when, and the
 * verdict) of the bound {@link ConfigRule}; the rule name is injected
 * automatically.
 *
 * Provide `Config.GetComplianceDetailsByConfigRuleHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Reading Compliance
 * @example Read a Rule's Evaluation Results
 * ```typescript
 * // init — grants config:GetComplianceDetailsByConfigRule
 * const getComplianceDetails =
 *   yield* AWS.Config.GetComplianceDetailsByConfigRule(rule);
 *
 * // runtime
 * const result = yield* getComplianceDetails({
 *   ComplianceTypes: ["NON_COMPLIANT"],
 * });
 * console.log(result.EvaluationResults);
 * ```
 */
export interface GetComplianceDetailsByConfigRule extends Binding.Service<
  GetComplianceDetailsByConfigRule,
  "AWS.Config.GetComplianceDetailsByConfigRule",
  (
    rule: ConfigRule,
  ) => Effect.Effect<
    (
      request?: GetComplianceDetailsByConfigRuleRequest,
    ) => Effect.Effect<
      config.GetComplianceDetailsByConfigRuleResponse,
      config.GetComplianceDetailsByConfigRuleError
    >
  >
> {}

export const GetComplianceDetailsByConfigRule =
  Binding.Service<GetComplianceDetailsByConfigRule>(
    "AWS.Config.GetComplianceDetailsByConfigRule",
  );
