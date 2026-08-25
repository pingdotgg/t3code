import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * Runtime binding for the `GetManagedThingConnectivityData` operation (IAM
 * action `iotmanagedintegrations:GetManagedThingConnectivityData`), scoped
 * to one {@link ManagedThing}.
 *
 * Reads whether the bound device is currently connected, when its
 * connectivity last changed, and the disconnect reason if offline. Provide
 * the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingConnectivityDataHttp)`.
 *
 * @binding
 * @section Reading Device State
 * @example Check Device Connectivity
 * ```typescript
 * const getConnectivity =
 *   yield* IoTManagedIntegrations.GetManagedThingConnectivityData(thing);
 *
 * const { Connected, DisconnectReason } = yield* getConnectivity();
 * ```
 */
export interface GetManagedThingConnectivityData extends Binding.Service<
  GetManagedThingConnectivityData,
  "AWS.IoTManagedIntegrations.GetManagedThingConnectivityData",
  (
    thing: ManagedThing,
  ) => Effect.Effect<
    () => Effect.Effect<
      mi.GetManagedThingConnectivityDataResponse,
      mi.GetManagedThingConnectivityDataError
    >
  >
> {}
export const GetManagedThingConnectivityData =
  Binding.Service<GetManagedThingConnectivityData>(
    "AWS.IoTManagedIntegrations.GetManagedThingConnectivityData",
  );
