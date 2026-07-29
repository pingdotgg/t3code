import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventBus } from "./EventBus.ts";

export interface DescribeEventBusRequest extends Omit<
  eventbridge.DescribeEventBusRequest,
  "Name"
> {}

/**
 * Reads the configuration of an EventBridge event bus
 * (`events:DescribeEventBus`).
 *
 * Bind this operation to an {@link EventBus} inside a function runtime to get
 * a callable that automatically injects the bus name. Provide the
 * `DescribeEventBusHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Describing Event Buses
 * @example Describe the Bound Bus
 * ```typescript
 * // init — bind the bus (provide AWS.EventBridge.DescribeEventBusHttp on the Function)
 * const describeEventBus = yield* AWS.EventBridge.DescribeEventBus(bus);
 *
 * // runtime — read the bus configuration
 * const info = yield* describeEventBus();
 * console.log(info.Arn, info.Policy);
 * ```
 */
export interface DescribeEventBus extends Binding.Service<
  DescribeEventBus,
  "AWS.EventBridge.DescribeEventBus",
  (
    bus: EventBus,
  ) => Effect.Effect<
    (
      request?: DescribeEventBusRequest,
    ) => Effect.Effect<
      eventbridge.DescribeEventBusResponse,
      eventbridge.DescribeEventBusError
    >
  >
> {}
export const DescribeEventBus = Binding.Service<DescribeEventBus>(
  "AWS.EventBridge.DescribeEventBus",
);
