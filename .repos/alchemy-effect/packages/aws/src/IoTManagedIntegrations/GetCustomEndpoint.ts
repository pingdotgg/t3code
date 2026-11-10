import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `iotmanagedintegrations:GetCustomEndpoint`
 * (account-level).
 *
 * Reads the account's custom MQTT endpoint address — the address devices
 * connect to for Managed integrations traffic. Provide the implementation
 * with `Effect.provide(AWS.IoTManagedIntegrations.GetCustomEndpointHttp)`.
 *
 * ### Connectivity
 * **Example:** Resolve the Custom Endpoint
 * ```typescript
 * const getCustomEndpoint = yield* IoTManagedIntegrations.GetCustomEndpoint();
 *
 * const { EndpointAddress } = yield* getCustomEndpoint();
 * ```
 *
 * @binding
 */
export interface GetCustomEndpoint extends Binding.Service<
  GetCustomEndpoint,
  "AWS.IoTManagedIntegrations.GetCustomEndpoint",
  () => Effect.Effect<() => Effect.Effect<mi.GetCustomEndpointResponse, mi.GetCustomEndpointError>>
> {}
export const GetCustomEndpoint = Binding.Service<GetCustomEndpoint>(
  "AWS.IoTManagedIntegrations.GetCustomEndpoint",
);
