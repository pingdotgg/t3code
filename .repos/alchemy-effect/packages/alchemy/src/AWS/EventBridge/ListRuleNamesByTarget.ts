import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListRuleNamesByTargetRequest
  extends eventbridge.ListRuleNamesByTargetRequest {}

/**
 * Lists the EventBridge rules that route events to a given target ARN
 * (`events:ListRuleNamesByTarget`).
 *
 * Bind this operation inside a function runtime to introspect which rules
 * feed a target (e.g. the function itself, or one of its queues). Provide
 * the `ListRuleNamesByTargetHttp` layer on the Function to satisfy the
 * binding.
 * @binding
 * @section Listing Rules
 * @example List Rules Feeding a Target
 * ```typescript
 * // init — bind the operation (provide AWS.EventBridge.ListRuleNamesByTargetHttp on the Function)
 * const listRuleNamesByTarget = yield* AWS.EventBridge.ListRuleNamesByTarget();
 *
 * // runtime — find every rule routing to the target
 * const { RuleNames } = yield* listRuleNamesByTarget({
 *   TargetArn: "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
 * });
 * ```
 */
export interface ListRuleNamesByTarget extends Binding.Service<
  ListRuleNamesByTarget,
  "AWS.EventBridge.ListRuleNamesByTarget",
  () => Effect.Effect<
    (
      request: ListRuleNamesByTargetRequest,
    ) => Effect.Effect<
      eventbridge.ListRuleNamesByTargetResponse,
      eventbridge.ListRuleNamesByTargetError
    >
  >
> {}
export const ListRuleNamesByTarget = Binding.Service<ListRuleNamesByTarget>(
  "AWS.EventBridge.ListRuleNamesByTarget",
);
