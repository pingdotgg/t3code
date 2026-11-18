import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeRuleHttpBinding } from "./BindingHttp.ts";
import { DescribeRule } from "./DescribeRule.ts";

/**
 * HTTP implementation of {@link DescribeRule}. At deploy time it grants
 * `events:DescribeRule` on the bound rule; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const DescribeRuleHttp = Layer.effect(
  DescribeRule,
  makeEventBridgeRuleHttpBinding({
    tag: "AWS.EventBridge.DescribeRule",
    operation: eventbridge.describeRule,
    actions: ["events:DescribeRule"],
    ruleNameKey: "Name",
  }),
);
