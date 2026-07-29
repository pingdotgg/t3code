import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchGetAutomationRules`.
 *
 * Returns the full configuration of a batch of automation rules by ARN.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchGetAutomationRulesHttp)`.
 * @binding
 * @section Custom Actions, Automation Rules & Aggregation
 * @example Hydrate Automation Rules
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchGetAutomationRules = yield* AWS.SecurityHub.BatchGetAutomationRules();
 *
 * // runtime
 * const { Rules } = yield* batchGetAutomationRules({
 *   AutomationRulesArns: [rule.ruleArn],
 * });
 * ```
 */
export interface BatchGetAutomationRules extends Binding.Service<
  BatchGetAutomationRules,
  "AWS.SecurityHub.BatchGetAutomationRules",
  () => Effect.Effect<
    (
      request?: securityhub.BatchGetAutomationRulesRequest,
    ) => Effect.Effect<
      securityhub.BatchGetAutomationRulesResponse,
      securityhub.BatchGetAutomationRulesError
    >
  >
> {}
export const BatchGetAutomationRules = Binding.Service<BatchGetAutomationRules>(
  "AWS.SecurityHub.BatchGetAutomationRules",
);
