import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rule } from "./Rule.ts";

/**
 * Enables an EventBridge rule (`events:EnableRule`) so it resumes matching
 * events.
 *
 * Bind this operation to a {@link Rule} inside a function runtime to get a
 * callable that re-enables the rule — the runtime half of a feature toggle
 * or kill switch. Provide the `EnableRuleHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Toggling Rules
 * @example Re-enable the Bound Rule
 * ```typescript
 * // init — bind the rule (provide AWS.EventBridge.EnableRuleHttp on the Function)
 * const enableRule = yield* AWS.EventBridge.EnableRule(rule);
 *
 * // runtime — turn event routing back on
 * yield* enableRule();
 * ```
 */
export interface EnableRule extends Binding.Service<
  EnableRule,
  "AWS.EventBridge.EnableRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    () => Effect.Effect<
      eventbridge.EnableRuleResponse,
      eventbridge.EnableRuleError
    >
  >
> {}
export const EnableRule = Binding.Service<EnableRule>(
  "AWS.EventBridge.EnableRule",
);
