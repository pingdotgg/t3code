import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Layer from "effect/Layer";
import { makeEventBridgeBusHttpBinding } from "./BindingHttp.ts";
import { DescribeEventBus } from "./DescribeEventBus.ts";

/**
 * HTTP implementation of {@link DescribeEventBus}. At deploy time it grants
 * `events:DescribeEventBus` on the bound bus; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const DescribeEventBusHttp = Layer.effect(
  DescribeEventBus,
  makeEventBridgeBusHttpBinding({
    tag: "AWS.EventBridge.DescribeEventBus",
    operation: eventbridge.describeEventBus,
    actions: ["events:DescribeEventBus"],
    busNameKey: "Name",
  }),
);
