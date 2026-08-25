import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListDeviceDiscoveries}.
 */
export interface ListDeviceDiscoveriesRequest
  extends mi.ListDeviceDiscoveriesRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:ListDeviceDiscoveries`
 * (account-level).
 *
 * Lists the discovery scans in the account, optionally filtered by type or
 * status — useful for finding a running scan before polling it with
 * {@link GetDeviceDiscovery}. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.ListDeviceDiscoveriesHttp)`.
 *
 * @binding
 * @section Discovering Devices
 * @example List Running Discovery Scans
 * ```typescript
 * const listDiscoveries = yield* IoTManagedIntegrations.ListDeviceDiscoveries();
 *
 * const { Items } = yield* listDiscoveries({ StatusFilter: "RUNNING" });
 * ```
 */
export interface ListDeviceDiscoveries extends Binding.Service<
  ListDeviceDiscoveries,
  "AWS.IoTManagedIntegrations.ListDeviceDiscoveries",
  () => Effect.Effect<
    (
      request?: ListDeviceDiscoveriesRequest,
    ) => Effect.Effect<
      mi.ListDeviceDiscoveriesResponse,
      mi.ListDeviceDiscoveriesError
    >
  >
> {}
export const ListDeviceDiscoveries = Binding.Service<ListDeviceDiscoveries>(
  "AWS.IoTManagedIntegrations.ListDeviceDiscoveries",
);
