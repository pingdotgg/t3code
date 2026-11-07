import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";
import { ListEventBuses } from "./ListEventBuses.ts";

/**
 * HTTP implementation of {@link ListEventBuses}. At deploy time it grants
 * `events:ListEventBuses`; at runtime it calls the EventBridge API with the
 * host Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListEventBusesHttp = Layer.effect(
  ListEventBuses,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.ListEventBuses",
    operation: eventbridge.listEventBuses,
    actions: ["events:ListEventBuses"],
  }),
);
