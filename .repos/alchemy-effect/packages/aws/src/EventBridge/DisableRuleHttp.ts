import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeRuleHttpBinding } from "./BindingHttp.ts";
import { DisableRule } from "./DisableRule.ts";

/**
 * HTTP implementation of {@link DisableRule}. At deploy time it grants
 * `events:DisableRule` on the bound rule; at runtime it calls the EventBridge
 * API with the host Function's credentials. Provide this layer on the
 * Function using the binding.
 */
export const DisableRuleHttp = Layer.effect(
  DisableRule,
  makeEventBridgeRuleHttpBinding({
    tag: "AWS.EventBridge.DisableRule",
    operation: eventbridge.disableRule,
    actions: ["events:DisableRule"],
    ruleNameKey: "Name",
  }),
);
