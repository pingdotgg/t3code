import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";
import { ListRuleNamesByTarget } from "./ListRuleNamesByTarget.ts";

/**
 * HTTP implementation of {@link ListRuleNamesByTarget}. At deploy time it
 * grants `events:ListRuleNamesByTarget` (the action does not support
 * resource-level permissions); at runtime it calls the EventBridge API with
 * the host Function's credentials. Provide this layer on the Function using
 * the binding.
 */
export const ListRuleNamesByTargetHttp = Layer.effect(
  ListRuleNamesByTarget,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.ListRuleNamesByTarget",
    operation: eventbridge.listRuleNamesByTarget,
    actions: ["events:ListRuleNamesByTarget"],
  }),
);
