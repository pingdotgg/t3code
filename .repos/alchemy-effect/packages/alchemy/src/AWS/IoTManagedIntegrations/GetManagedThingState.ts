import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * Runtime binding for the `GetManagedThingState` operation (IAM action
 * `iotmanagedintegrations:GetManagedThingState`), scoped to one
 * {@link ManagedThing}.
 *
 * Reads the last-reported state of every endpoint/capability of the bound
 * device (e.g. whether a smart plug is on). Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingStateHttp)`.
 *
 * @binding
 * @section Reading Device State
 * @example Read the Current Device State
 * ```typescript
 * const getState = yield* IoTManagedIntegrations.GetManagedThingState(thing);
 *
 * const { Endpoints } = yield* getState();
 * // Endpoints[0].capabilities[0].properties
 * ```
 */
export interface GetManagedThingState extends Binding.Service<
  GetManagedThingState,
  "AWS.IoTManagedIntegrations.GetManagedThingState",
  (
    thing: ManagedThing,
  ) => Effect.Effect<
    () => Effect.Effect<
      mi.GetManagedThingStateResponse,
      mi.GetManagedThingStateError
    >
  >
> {}
export const GetManagedThingState = Binding.Service<GetManagedThingState>(
  "AWS.IoTManagedIntegrations.GetManagedThingState",
);
