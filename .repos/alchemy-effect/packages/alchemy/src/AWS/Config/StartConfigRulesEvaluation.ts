import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConfigRule } from "./ConfigRule.ts";

/**
 * Runtime binding for `config:StartConfigRulesEvaluation` — run an
 * on-demand evaluation of the bound {@link ConfigRule} against the last
 * known configuration state of your resources; the rule name is injected
 * automatically.
 *
 * Provide `Config.StartConfigRulesEvaluationHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Rule Evaluation Status
 * @example Re-Evaluate a Rule On Demand
 * ```typescript
 * // init — grants config:StartConfigRulesEvaluation
 * const startRulesEvaluation =
 *   yield* AWS.Config.StartConfigRulesEvaluation(rule);
 *
 * // runtime
 * yield* startRulesEvaluation();
 * ```
 */
export interface StartConfigRulesEvaluation extends Binding.Service<
  StartConfigRulesEvaluation,
  "AWS.Config.StartConfigRulesEvaluation",
  (
    rule: ConfigRule,
  ) => Effect.Effect<
    () => Effect.Effect<
      config.StartConfigRulesEvaluationResponse,
      config.StartConfigRulesEvaluationError
    >
  >
> {}

export const StartConfigRulesEvaluation =
  Binding.Service<StartConfigRulesEvaluation>(
    "AWS.Config.StartConfigRulesEvaluation",
  );
