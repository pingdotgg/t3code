import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeRuleHttpBinding } from "./BindingHttp.ts";
import { EnableRule } from "./EnableRule.ts";

/**
 * HTTP implementation of {@link EnableRule}. At deploy time it grants
 * `events:EnableRule` on the bound rule; at runtime it calls the EventBridge
 * API with the host Function's credentials. Provide this layer on the
 * Function using the binding.
 */
export const EnableRuleHttp = Layer.effect(
  EnableRule,
  makeEventBridgeRuleHttpBinding({
    tag: "AWS.EventBridge.EnableRule",
    operation: eventbridge.enableRule,
    actions: ["events:EnableRule"],
    ruleNameKey: "Name",
  }),
);
