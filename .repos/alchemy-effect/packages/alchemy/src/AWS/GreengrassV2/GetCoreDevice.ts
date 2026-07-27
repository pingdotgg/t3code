import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:GetCoreDevice`.
 *
 * Reads one core device's metadata — status (`HEALTHY` / `UNHEALTHY`),
 * nucleus version, platform, and last status-update timestamp. Core devices
 * register themselves (they are not Alchemy resources), so the caller
 * supplies the core device thing name at runtime. Provide the implementation
 * with `Effect.provide(AWS.GreengrassV2.GetCoreDeviceHttp)`.
 * @binding
 * @section Managing Core Devices
 * @example Check A Core Device's Health
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getCoreDevice = yield* AWS.GreengrassV2.GetCoreDevice();
 *
 * // runtime
 * const device = yield* getCoreDevice({ coreDeviceThingName: "MyCore" });
 * yield* Effect.log(`${device.coreDeviceThingName} is ${device.status}`);
 * ```
 */
export interface GetCoreDevice extends Binding.Service<
  GetCoreDevice,
  "AWS.GreengrassV2.GetCoreDevice",
  () => Effect.Effect<
    (
      request: greengrassv2.GetCoreDeviceRequest,
    ) => Effect.Effect<
      greengrassv2.GetCoreDeviceResponse,
      greengrassv2.GetCoreDeviceError
    >
  >
> {}
export const GetCoreDevice = Binding.Service<GetCoreDevice>(
  "AWS.GreengrassV2.GetCoreDevice",
);
