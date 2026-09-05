import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeBusHttpBinding } from "./BindingHttp.ts";
import { ListRules } from "./ListRules.ts";

/**
 * HTTP implementation of {@link ListRules}. At deploy time it grants
 * `events:ListRules`; at runtime it calls the EventBridge API with the host
 * Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListRulesHttp = Layer.effect(
  ListRules,
  makeEventBridgeBusHttpBinding({
    tag: "AWS.EventBridge.ListRules",
    operation: eventbridge.listRules,
    actions: ["events:ListRules"],
    busNameKey: "EventBusName",
    // events:ListRules does not support resource-level permissions — a grant
    // scoped to the bus ARN is AccessDenied at runtime. Grant on `*`.
    resources: () => ["*"],
  }),
);
