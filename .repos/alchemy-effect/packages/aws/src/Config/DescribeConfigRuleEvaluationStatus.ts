import type * as config from "@distilled.cloud/aws/config-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `config:DescribeConfigRuleEvaluationStatus` — read
 * the evaluation status (last invocation, last failure, first-evaluation
 * flag) of your Config rules.
 *
 * Provide `Config.DescribeConfigRuleEvaluationStatusHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * ### Rule Evaluation Status
 * **Example:** Read Rule Evaluation Status
 * ```typescript
 * // init — grants config:DescribeConfigRuleEvaluationStatus
 * const describeConfigRuleEvaluationStatus = yield* AWS.Config.DescribeConfigRuleEvaluationStatus();
 *
 * // runtime
 * const result = yield* describeConfigRuleEvaluationStatus();
 * for (const status of result.ConfigRulesEvaluationStatus ?? []) {
 *   console.log(status.ConfigRuleName, status.LastSuccessfulInvocationTime);
 * }
 * ```
 *
 * @binding
 */
export interface DescribeConfigRuleEvaluationStatus extends Binding.Service<
  DescribeConfigRuleEvaluationStatus,
  "AWS.Config.DescribeConfigRuleEvaluationStatus",
  () => Effect.Effect<
    (
      request?: config.DescribeConfigRuleEvaluationStatusRequest,
    ) => Effect.Effect<
      config.DescribeConfigRuleEvaluationStatusResponse,
      config.DescribeConfigRuleEvaluationStatusError
    >
  >
> {}

export const DescribeConfigRuleEvaluationStatus =
  Binding.Service<DescribeConfigRuleEvaluationStatus>(
    "AWS.Config.DescribeConfigRuleEvaluationStatus",
  );
