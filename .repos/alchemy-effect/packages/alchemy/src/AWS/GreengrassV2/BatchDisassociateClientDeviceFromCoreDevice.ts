import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:BatchDisassociateClientDeviceFromCoreDevice`.
 *
 * Removes up to 100 client-device associations from a core device — the
 * cleanup half of client-device fleet management. The caller supplies the
 * core device thing name and the client device entries at runtime. Provide
 * the implementation with
 * `Effect.provide(AWS.GreengrassV2.BatchDisassociateClientDeviceFromCoreDeviceHttp)`.
 * @binding
 * @section Managing Client Devices
 * @example Disassociate Client Devices
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disassociateClientDevices =
 *   yield* AWS.GreengrassV2.BatchDisassociateClientDeviceFromCoreDevice();
 *
 * // runtime
 * const { errorEntries } = yield* disassociateClientDevices({
 *   coreDeviceThingName: "MyCore",
 *   entries: [{ thingName: "RetiredSensor" }],
 * });
 * ```
 */
export interface BatchDisassociateClientDeviceFromCoreDevice extends Binding.Service<
  BatchDisassociateClientDeviceFromCoreDevice,
  "AWS.GreengrassV2.BatchDisassociateClientDeviceFromCoreDevice",
  () => Effect.Effect<
    (
      request: greengrassv2.BatchDisassociateClientDeviceFromCoreDeviceRequest,
    ) => Effect.Effect<
      greengrassv2.BatchDisassociateClientDeviceFromCoreDeviceResponse,
      greengrassv2.BatchDisassociateClientDeviceFromCoreDeviceError
    >
  >
> {}
export const BatchDisassociateClientDeviceFromCoreDevice =
  Binding.Service<BatchDisassociateClientDeviceFromCoreDevice>(
    "AWS.GreengrassV2.BatchDisassociateClientDeviceFromCoreDevice",
  );
