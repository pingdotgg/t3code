import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ListCoreDevices`.
 *
 * Enumerates the account's Greengrass core devices, optionally filtered by
 * status (`HEALTHY` / `UNHEALTHY`), thing group, or nucleus runtime — the
 * entry point for fleet-health dashboards. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.ListCoreDevicesHttp)`.
 * @binding
 * @section Managing Core Devices
 * @example Find Unhealthy Core Devices
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listCoreDevices = yield* AWS.GreengrassV2.ListCoreDevices();
 *
 * // runtime
 * const { coreDevices } = yield* listCoreDevices({ status: "UNHEALTHY" });
 * ```
 */
export interface ListCoreDevices extends Binding.Service<
  ListCoreDevices,
  "AWS.GreengrassV2.ListCoreDevices",
  () => Effect.Effect<
    (
      request?: greengrassv2.ListCoreDevicesRequest,
    ) => Effect.Effect<
      greengrassv2.ListCoreDevicesResponse,
      greengrassv2.ListCoreDevicesError
    >
  >
> {}
export const ListCoreDevices = Binding.Service<ListCoreDevices>(
  "AWS.GreengrassV2.ListCoreDevices",
);
