import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface SendDirectMessageRequest
  extends iotdata.SendDirectMessageRequest {}

/**
 * Runtime binding for the IoT data-plane `SendDirectMessage` operation (IAM
 * action `iot:SendDirectMessage`).
 *
 * Binding to a client id filter grants `iot:SendDirectMessage` on matching
 * MQTT client ARNs (or all clients when the filter is omitted) and returns
 * a callable that delivers a message directly to a connected client without
 * publishing through a topic. Provide the implementation with
 * `Effect.provide(AWS.IoT.SendDirectMessageHttp)`.
 * @binding
 * @section MQTT Connections
 * @example Send a Command to a Device
 * ```typescript
 * const sendDirectMessage = yield* AWS.IoT.SendDirectMessage("sensor-*");
 *
 * yield* sendDirectMessage({
 *   clientId: "sensor-1",
 *   topic: "commands/reboot",
 *   payload: JSON.stringify({ at: "now" }),
 * });
 * ```
 */
export interface SendDirectMessage extends Binding.Service<
  SendDirectMessage,
  "AWS.IoT.SendDirectMessage",
  (
    clientIdFilter?: string,
  ) => Effect.Effect<
    (
      request: SendDirectMessageRequest,
    ) => Effect.Effect<
      iotdata.SendDirectMessageResponse,
      iotdata.SendDirectMessageError
    >
  >
> {}

export const SendDirectMessage = Binding.Service<SendDirectMessage>(
  "AWS.IoT.SendDirectMessage",
);
