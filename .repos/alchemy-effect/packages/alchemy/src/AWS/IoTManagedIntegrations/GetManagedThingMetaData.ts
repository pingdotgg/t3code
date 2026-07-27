import type * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ManagedThing } from "./ManagedThing.ts";

/**
 * Runtime binding for the `GetManagedThingMetaData` operation (IAM action
 * `iotmanagedintegrations:GetManagedThingMetaData`), scoped to one
 * {@link ManagedThing}.
 *
 * Reads the metadata key-value pairs attached to the bound managed thing.
 * Provide the implementation with
 * `Effect.provide(AWS.IoTManagedIntegrations.GetManagedThingMetaDataHttp)`.
 *
 * @binding
 * @section Reading Device State
 * @example Read Device Metadata
 * ```typescript
 * const getMetaData =
 *   yield* IoTManagedIntegrations.GetManagedThingMetaData(thing);
 *
 * const { MetaData } = yield* getMetaData();
 * ```
 */
export interface GetManagedThingMetaData extends Binding.Service<
  GetManagedThingMetaData,
  "AWS.IoTManagedIntegrations.GetManagedThingMetaData",
  (
    thing: ManagedThing,
  ) => Effect.Effect<
    () => Effect.Effect<
      mi.GetManagedThingMetaDataResponse,
      mi.GetManagedThingMetaDataError
    >
  >
> {}
export const GetManagedThingMetaData = Binding.Service<GetManagedThingMetaData>(
  "AWS.IoTManagedIntegrations.GetManagedThingMetaData",
);
