import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ListClientDevicesAssociatedWithCoreDevice`.
 *
 * Enumerates the client devices associated with a core device (the IoT
 * things allowed to connect to the core's local MQTT broker). The caller
 * supplies the core device thing name at runtime. Provide the implementation
 * with
 * `Effect.provide(AWS.GreengrassV2.ListClientDevicesAssociatedWithCoreDeviceHttp)`.
 * @binding
 * @section Managing Client Devices
 * @example List A Core's Client Devices
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listClientDevices =
 *   yield* AWS.GreengrassV2.ListClientDevicesAssociatedWithCoreDevice();
 *
 * // runtime
 * const { associatedClientDevices } = yield* listClientDevices({
 *   coreDeviceThingName: "MyCore",
 * });
 * ```
 */
export interface ListClientDevicesAssociatedWithCoreDevice extends Binding.Service<
  ListClientDevicesAssociatedWithCoreDevice,
  "AWS.GreengrassV2.ListClientDevicesAssociatedWithCoreDevice",
  () => Effect.Effect<
    (
      request: greengrassv2.ListClientDevicesAssociatedWithCoreDeviceRequest,
    ) => Effect.Effect<
      greengrassv2.ListClientDevicesAssociatedWithCoreDeviceResponse,
      greengrassv2.ListClientDevicesAssociatedWithCoreDeviceError
    >
  >
> {}
export const ListClientDevicesAssociatedWithCoreDevice =
  Binding.Service<ListClientDevicesAssociatedWithCoreDevice>(
    "AWS.GreengrassV2.ListClientDevicesAssociatedWithCoreDevice",
  );
