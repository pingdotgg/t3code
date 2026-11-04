import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeRuleHttpBinding } from "./BindingHttp.ts";
import { ListTargetsByRule } from "./ListTargetsByRule.ts";

/**
 * HTTP implementation of {@link ListTargetsByRule}. At deploy time it grants
 * `events:ListTargetsByRule` on the bound rule; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const ListTargetsByRuleHttp = Layer.effect(
  ListTargetsByRule,
  makeEventBridgeRuleHttpBinding({
    tag: "AWS.EventBridge.ListTargetsByRule",
    operation: eventbridge.listTargetsByRule,
    actions: ["events:ListTargetsByRule"],
    ruleNameKey: "Rule",
  }),
);
