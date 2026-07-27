import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";

/**
 * Request for {@link TestWirelessDevice}. The bound device's id is injected
 * automatically, leaving nothing else to supply.
 */
export interface TestWirelessDeviceRequest extends Omit<
  iotw.TestWirelessDeviceRequest,
  "Id"
> {}

/**
 * Runtime binding for `iotwireless:TestWirelessDevice` — simulate a
 * provisioned device by sending an uplink data payload of `Hello` on behalf
 * of the bound wireless device, from a deployed Lambda or Task. Useful for
 * verifying a destination's routing without radio hardware.
 *
 * @binding
 * @section Simulating an Uplink
 * Provide the `TestWirelessDeviceHttp` implementation layer on the Function
 * effect, bind the device in the init phase, then call the returned client
 * at runtime.
 *
 * @example Send a Test Uplink
 * ```typescript
 * // init
 * const testDevice = yield* AWS.IoTWireless.TestWirelessDevice(device);
 *
 * // runtime
 * const { Result } = yield* testDevice();
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.TestWirelessDeviceHttp))
 * ```
 */
export interface TestWirelessDevice extends Binding.Service<
  TestWirelessDevice,
  "AWS.IoTWireless.TestWirelessDevice",
  (
    device: WirelessDevice,
  ) => Effect.Effect<
    (
      request?: TestWirelessDeviceRequest,
    ) => Effect.Effect<
      iotw.TestWirelessDeviceResponse,
      iotw.TestWirelessDeviceError
    >
  >
> {}
export const TestWirelessDevice = Binding.Service<TestWirelessDevice>(
  "AWS.IoTWireless.TestWirelessDevice",
);
