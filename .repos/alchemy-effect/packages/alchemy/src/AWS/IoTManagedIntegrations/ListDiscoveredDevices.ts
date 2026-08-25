import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListDiscoveredDevices}.
 */
export interface ListDiscoveredDevicesRequest
  extends mi.ListDiscoveredDevicesRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:ListDiscoveredDevices`
 * (account-level).
 *
 * Lists the devices found by a discovery scan, including the managed thing
 * id assigned to each already-onboarded device. Provide the implementation
 * with `Effect.provide(AWS.IoTManagedIntegrations.ListDiscoveredDevicesHttp)`.
 *
 * @binding
 * @section Discovering Devices
 * @example List Devices Found by a Scan
 * ```typescript
 * const listDiscovered = yield* IoTManagedIntegrations.ListDiscoveredDevices();
 *
 * const { Items } = yield* listDiscovered({ Identifier: discoveryId });
 * ```
 */
export interface ListDiscoveredDevices extends Binding.Service<
  ListDiscoveredDevices,
  "AWS.IoTManagedIntegrations.ListDiscoveredDevices",
  () => Effect.Effect<
    (
      request: ListDiscoveredDevicesRequest,
    ) => Effect.Effect<
      mi.ListDiscoveredDevicesResponse,
      mi.ListDiscoveredDevicesError
    >
  >
> {}
export const ListDiscoveredDevices = Binding.Service<ListDiscoveredDevices>(
  "AWS.IoTManagedIntegrations.ListDiscoveredDevices",
);
