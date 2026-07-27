import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";

/**
 * Request for {@link SendDataToWirelessDevice}. The bound device's id is
 * injected automatically.
 */
export interface SendDataToWirelessDeviceRequest extends Omit<
  iotw.SendDataToWirelessDeviceRequest,
  "Id"
> {}

/**
 * Runtime binding for `iotwireless:SendDataToWirelessDevice` — queue a
 * downlink message to the bound wireless device from a deployed Lambda or
 * Task. The message is delivered the next time the device opens a receive
 * window.
 *
 * @binding
 * @section Sending Downlink Messages
 * Provide the `SendDataToWirelessDeviceHttp` implementation layer on the
 * Function effect, bind the device in the init phase, then call the
 * returned client at runtime.
 *
 * @example Queue a Downlink to a LoRaWAN Device
 * ```typescript
 * // init
 * const sendData = yield* AWS.IoTWireless.SendDataToWirelessDevice(device);
 *
 * // runtime — PayloadData is base64-encoded
 * const { MessageId } = yield* sendData({
 *   PayloadData: Buffer.from("hello").toString("base64"),
 *   TransmitMode: 1,
 *   WirelessMetadata: { LoRaWAN: { FPort: 1 } },
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.SendDataToWirelessDeviceHttp))
 * ```
 */
export interface SendDataToWirelessDevice extends Binding.Service<
  SendDataToWirelessDevice,
  "AWS.IoTWireless.SendDataToWirelessDevice",
  (
    device: WirelessDevice,
  ) => Effect.Effect<
    (
      request: SendDataToWirelessDeviceRequest,
    ) => Effect.Effect<
      iotw.SendDataToWirelessDeviceResponse,
      iotw.SendDataToWirelessDeviceError
    >
  >
> {}
export const SendDataToWirelessDevice =
  Binding.Service<SendDataToWirelessDevice>(
    "AWS.IoTWireless.SendDataToWirelessDevice",
  );
