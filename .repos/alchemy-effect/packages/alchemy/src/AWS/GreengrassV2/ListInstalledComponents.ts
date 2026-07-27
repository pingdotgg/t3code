import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ListInstalledComponents`.
 *
 * Enumerates the components actually installed on a core device (name,
 * version, lifecycle state such as `RUNNING` or `BROKEN`, and last status
 * report) — the ground truth for "what is this device really running". The
 * caller supplies the core device thing name at runtime. Provide the
 * implementation with
 * `Effect.provide(AWS.GreengrassV2.ListInstalledComponentsHttp)`.
 * @binding
 * @section Managing Core Devices
 * @example Audit A Device's Installed Components
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listInstalledComponents = yield* AWS.GreengrassV2.ListInstalledComponents();
 *
 * // runtime
 * const { installedComponents } = yield* listInstalledComponents({
 *   coreDeviceThingName: "MyCore",
 * });
 * ```
 */
export interface ListInstalledComponents extends Binding.Service<
  ListInstalledComponents,
  "AWS.GreengrassV2.ListInstalledComponents",
  () => Effect.Effect<
    (
      request: greengrassv2.ListInstalledComponentsRequest,
    ) => Effect.Effect<
      greengrassv2.ListInstalledComponentsResponse,
      greengrassv2.ListInstalledComponentsError
    >
  >
> {}
export const ListInstalledComponents = Binding.Service<ListInstalledComponents>(
  "AWS.GreengrassV2.ListInstalledComponents",
);
