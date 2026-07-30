import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:BatchAssociateClientDeviceWithCoreDevice`.
 *
 * Associates up to 100 client devices with a core device so they can use it
 * as their local MQTT broker — the write half of client-device fleet
 * management. The caller supplies the core device thing name and the client
 * device entries at runtime. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.BatchAssociateClientDeviceWithCoreDeviceHttp)`.
 * @binding
 * @section Managing Client Devices
 * @example Associate Client Devices
 * ```typescript
 * // init — account-level binding, no resource argument
 * const associateClientDevices =
 *   yield* AWS.GreengrassV2.BatchAssociateClientDeviceWithCoreDevice();
 *
 * // runtime
 * const { errorEntries } = yield* associateClientDevices({
 *   coreDeviceThingName: "MyCore",
 *   entries: [{ thingName: "Sensor1" }, { thingName: "Sensor2" }],
 * });
 * ```
 */
export interface BatchAssociateClientDeviceWithCoreDevice extends Binding.Service<
  BatchAssociateClientDeviceWithCoreDevice,
  "AWS.GreengrassV2.BatchAssociateClientDeviceWithCoreDevice",
  () => Effect.Effect<
    (
      request: greengrassv2.BatchAssociateClientDeviceWithCoreDeviceRequest,
    ) => Effect.Effect<
      greengrassv2.BatchAssociateClientDeviceWithCoreDeviceResponse,
      greengrassv2.BatchAssociateClientDeviceWithCoreDeviceError
    >
  >
> {}
export const BatchAssociateClientDeviceWithCoreDevice =
  Binding.Service<BatchAssociateClientDeviceWithCoreDevice>(
    "AWS.GreengrassV2.BatchAssociateClientDeviceWithCoreDevice",
  );
