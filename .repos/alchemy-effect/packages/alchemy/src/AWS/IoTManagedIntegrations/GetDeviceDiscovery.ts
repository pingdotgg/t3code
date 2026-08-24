import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetDeviceDiscovery}.
 */
export interface GetDeviceDiscoveryRequest
  extends mi.GetDeviceDiscoveryRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:GetDeviceDiscovery`
 * (account-level).
 *
 * Reads the status of a discovery scan started with
 * {@link StartDeviceDiscovery}. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.GetDeviceDiscoveryHttp)`.
 *
 * @binding
 * @section Discovering Devices
 * @example Poll a Discovery Scan
 * ```typescript
 * const getDiscovery = yield* IoTManagedIntegrations.GetDeviceDiscovery();
 *
 * const { Status } = yield* getDiscovery({ Identifier: discoveryId });
 * ```
 */
export interface GetDeviceDiscovery extends Binding.Service<
  GetDeviceDiscovery,
  "AWS.IoTManagedIntegrations.GetDeviceDiscovery",
  () => Effect.Effect<
    (
      request: GetDeviceDiscoveryRequest,
    ) => Effect.Effect<
      mi.GetDeviceDiscoveryResponse,
      mi.GetDeviceDiscoveryError
    >
  >
> {}
export const GetDeviceDiscovery = Binding.Service<GetDeviceDiscovery>(
  "AWS.IoTManagedIntegrations.GetDeviceDiscovery",
);
