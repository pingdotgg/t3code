import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link StartDeviceDiscovery}.
 */
export interface StartDeviceDiscoveryRequest
  extends mi.StartDeviceDiscoveryRequest {}

/**
 * Runtime binding for `iotmanagedintegrations:StartDeviceDiscovery`
 * (account-level).
 *
 * Starts a discovery scan for devices reachable through a controller
 * (`ZWAVE`/`ZIGBEE`), a cloud-to-cloud connector (`CLOUD`), or a custom
 * protocol. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.StartDeviceDiscoveryHttp)`.
 *
 * @binding
 * @section Discovering Devices
 * @example Start a Zigbee Discovery Scan
 * ```typescript
 * // init — account-level binding takes no resource
 * const startDiscovery = yield* IoTManagedIntegrations.StartDeviceDiscovery();
 *
 * // runtime
 * const { Id } = yield* startDiscovery({
 *   DiscoveryType: "ZIGBEE",
 *   ControllerIdentifier: controllerManagedThingId,
 * });
 * ```
 */
export interface StartDeviceDiscovery extends Binding.Service<
  StartDeviceDiscovery,
  "AWS.IoTManagedIntegrations.StartDeviceDiscovery",
  () => Effect.Effect<
    (
      request: StartDeviceDiscoveryRequest,
    ) => Effect.Effect<
      mi.StartDeviceDiscoveryResponse,
      mi.StartDeviceDiscoveryError
    >
  >
> {}
export const StartDeviceDiscovery = Binding.Service<StartDeviceDiscovery>(
  "AWS.IoTManagedIntegrations.StartDeviceDiscovery",
);
