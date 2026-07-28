import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";

/**
 * `GetGeofence` request with `CollectionName` injected from the bound
 * resource.
 */
export interface GetGeofenceRequest extends Omit<
  location.GetGeofenceRequest,
  "CollectionName"
> {}

/**
 * Retrieves a geofence's geometry and status from the collection.
 *
 * Runtime binding for the `GetGeofence` operation (IAM action
 * `geo:GetGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetGeofenceHttp)`.
 *
 * @binding
 * @section Reading Geofences
 * @example Read a Geofence
 * ```typescript
 * const getGeofence = yield* Location.GetGeofence(collection);
 *
 * const fence = yield* getGeofence({ GeofenceId: "warehouse" });
 * // fence.Status → "ACTIVE" once evaluable
 * ```
 */
export interface GetGeofence extends Binding.Service<
  GetGeofence,
  "AWS.Location.GetGeofence",
  (
    collection: GeofenceCollection,
  ) => Effect.Effect<
    (
      request: GetGeofenceRequest,
    ) => Effect.Effect<location.GetGeofenceResponse, location.GetGeofenceError>
  >
> {}
export const GetGeofence = Binding.Service<GetGeofence>(
  "AWS.Location.GetGeofence",
);
