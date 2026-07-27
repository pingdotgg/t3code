import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rule } from "./Rule.ts";

export interface ListTargetsByRuleRequest extends Omit<
  eventbridge.ListTargetsByRuleRequest,
  "Rule" | "EventBusName"
> {}

/**
 * Lists the targets attached to an EventBridge rule
 * (`events:ListTargetsByRule`).
 *
 * Bind this operation to a {@link Rule} inside a function runtime to get a
 * callable that automatically injects the rule and bus names. Provide the
 * `ListTargetsByRuleHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Listing Targets
 * @example List a Rule's Targets
 * ```typescript
 * // init — bind the rule (provide AWS.EventBridge.ListTargetsByRuleHttp on the Function)
 * const listTargets = yield* AWS.EventBridge.ListTargetsByRule(rule);
 *
 * // runtime — enumerate the rule's targets
 * const { Targets } = yield* listTargets();
 * ```
 */
export interface ListTargetsByRule extends Binding.Service<
  ListTargetsByRule,
  "AWS.EventBridge.ListTargetsByRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    (
      request?: ListTargetsByRuleRequest,
    ) => Effect.Effect<
      eventbridge.ListTargetsByRuleResponse,
      eventbridge.ListTargetsByRuleError
    >
  >
> {}
export const ListTargetsByRule = Binding.Service<ListTargetsByRule>(
  "AWS.EventBridge.ListTargetsByRule",
);
