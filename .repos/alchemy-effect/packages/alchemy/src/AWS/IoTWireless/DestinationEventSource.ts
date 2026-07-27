import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Destination } from "./Destination.ts";

/**
 * The JSON envelope AWS IoT Core for LoRaWAN delivers to a `RuleName`
 * destination's IoT rule for every uplink — the raw payload (base64) plus
 * the radio metadata.
 */
export interface WirelessUplinkMessage {
  /** ID of the wireless device that sent the uplink. */
  WirelessDeviceId: string;
  /** The uplink payload, base64-encoded. */
  PayloadData: string;
  /** Radio metadata (DevEui, FPort, data rate, gateway RSSI/SNR, ...). */
  WirelessMetadata?: {
    /** LoRaWAN uplink metadata. */
    LoRaWAN?: {
      /** The DevEui of the sending device. */
      DevEui?: string;
      /** The FPort the payload was sent on. */
      FPort?: number;
      /** ISO-8601 server-side receive timestamp. */
      Timestamp?: string;
      [key: string]: unknown;
    };
    /** Amazon Sidewalk uplink metadata. */
    Sidewalk?: { [key: string]: unknown };
  };
  [key: string]: unknown;
}

/**
 * The handler invoked with a stream of uplink messages routed through the
 * bound destination.
 */
export type WirelessUplinkHandlerFn<Req = never> = (
  stream: Stream.Stream<WirelessUplinkMessage>,
) => Effect.Effect<void, never, Req>;

export type DestinationEventSourceService = <Req = never>(
  destination: Destination,
  process: WirelessUplinkHandlerFn<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting an IoT Wireless {@link Destination} to the
 * hosting compute — every uplink a wireless device sends through the
 * destination invokes the handler.
 *
 * The destination must use `expressionType: "RuleName"`. At deploy time the
 * Lambda implementation (`Lambda.WirelessDestinationEventSource`) creates
 * the IoT topic rule the destination's `expression` names, with a Lambda
 * action targeting the current function, and grants `iot.amazonaws.com`
 * permission to invoke it; at runtime it dispatches uplink invocations to
 * the handler.
 *
 * Use the {@link consumeUplinks} helper rather than the service directly,
 * and provide `Lambda.WirelessDestinationEventSource` on the hosting
 * function.
 * @binding
 * @section Consuming Uplinks
 * @example Consume LoRaWAN Uplinks in a Lambda
 * ```typescript
 * export default IngestFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const destination = yield* IoTWireless.Destination("Uplinks", {
 *       expressionType: "RuleName",
 *       expression: "sensor_uplinks",
 *       roleArn: deliveryRole.roleArn,
 *     });
 *
 *     // deploy: creates the `sensor_uplinks` IoT rule targeting this Lambda
 *     // runtime: handles every uplink routed through the destination
 *     yield* IoTWireless.consumeUplinks(destination, (uplinks) =>
 *       uplinks.pipe(
 *         Stream.runForEach((uplink) =>
 *           Effect.log(uplink.WirelessDeviceId, uplink.PayloadData),
 *         ),
 *         Effect.orDie,
 *       ),
 *     );
 *
 *     return {};
 *   }).pipe(Effect.provide(Lambda.WirelessDestinationEventSource)),
 * );
 * ```
 */
export interface DestinationEventSource extends Binding.Service<
  DestinationEventSource,
  "AWS.IoTWireless.DestinationEventSource",
  DestinationEventSourceService
> {}

export const DestinationEventSource = Binding.Service<DestinationEventSource>(
  "AWS.IoTWireless.DestinationEventSource",
);

/**
 * Invoke an Effect handler for every uplink message routed through the
 * destination, by creating the IoT rule the destination's `expression`
 * names with a Lambda action targeting the current function.
 *
 * Provide `Lambda.WirelessDestinationEventSource` on the hosting function
 * to satisfy the requirement.
 *
 * @param destination The `RuleName` destination whose uplinks to consume.
 * @param process The handler invoked with a stream of uplink messages.
 *
 * @example Store uplinks in DynamoDB
 * ```typescript
 * yield* IoTWireless.consumeUplinks(destination, (uplinks) =>
 *   uplinks.pipe(
 *     Stream.runForEach((uplink) =>
 *       putItem({ Item: { pk: { S: uplink.WirelessDeviceId } } }),
 *     ),
 *     Effect.orDie,
 *   ),
 * );
 * ```
 */
export function consumeUplinks<Req = never>(
  destination: Destination,
  process: WirelessUplinkHandlerFn<Req>,
): Effect.Effect<void, never, DestinationEventSource> {
  return DestinationEventSource.use((source) => source(destination, process));
}
