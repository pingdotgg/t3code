import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * Runtime binding for the `GetManagedThingCapabilities` operation (IAM
 * action `iotmanagedintegrations:GetManagedThingCapabilities`), scoped to
 * one {@link ManagedThing}.
 *
 * Reads the capability report the bound device registered at onboarding —
 * the data model that {@link SendManagedThingCommand} commands are written
 * against. Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingCapabilitiesHttp)`.
 *
 * @binding
 * @section Reading Device State
 * @example Inspect the Device Capability Report
 * ```typescript
 * const getCapabilities =
 *   yield* IoTManagedIntegrations.GetManagedThingCapabilities(thing);
 *
 * const { CapabilityReport } = yield* getCapabilities();
 * // CapabilityReport?.endpoints[0].capabilities
 * ```
 */
export interface GetManagedThingCapabilities extends Binding.Service<
  GetManagedThingCapabilities,
  "AWS.IoTManagedIntegrations.GetManagedThingCapabilities",
  (
    thing: ManagedThing,
  ) => Effect.Effect<
    () => Effect.Effect<
      mi.GetManagedThingCapabilitiesResponse,
      mi.GetManagedThingCapabilitiesError
    >
  >
> {}
export const GetManagedThingCapabilities =
  Binding.Service<GetManagedThingCapabilities>(
    "AWS.IoTManagedIntegrations.GetManagedThingCapabilities",
  );
