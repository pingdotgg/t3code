import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:DeleteCoreDevice`.
 *
 * Deregisters a core device from IoT Greengrass (the backing IoT thing is
 * untouched) — the fleet-decommissioning primitive for automation that
 * retires devices. The caller supplies the core device thing name at
 * runtime. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.DeleteCoreDeviceHttp)`.
 * @binding
 * @section Managing Core Devices
 * @example Decommission A Core Device
 * ```typescript
 * // init — account-level binding, no resource argument
 * const deleteCoreDevice = yield* AWS.GreengrassV2.DeleteCoreDevice();
 *
 * // runtime
 * yield* deleteCoreDevice({ coreDeviceThingName: "RetiredCore" });
 * ```
 */
export interface DeleteCoreDevice extends Binding.Service<
  DeleteCoreDevice,
  "AWS.GreengrassV2.DeleteCoreDevice",
  () => Effect.Effect<
    (
      request: greengrassv2.DeleteCoreDeviceRequest,
    ) => Effect.Effect<
      greengrassv2.DeleteCoreDeviceResponse,
      greengrassv2.DeleteCoreDeviceError
    >
  >
> {}
export const DeleteCoreDevice = Binding.Service<DeleteCoreDevice>(
  "AWS.GreengrassV2.DeleteCoreDevice",
);
