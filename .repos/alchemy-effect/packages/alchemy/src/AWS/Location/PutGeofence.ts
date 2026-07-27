import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";

/**
 * `PutGeofence` request with `CollectionName` injected from the bound
 * resource.
 */
export interface PutGeofenceRequest extends Omit<
  location.PutGeofenceRequest,
  "CollectionName"
> {}

/**
 * Stores (creates or replaces) a single geofence geometry in the collection.
 *
 * Runtime binding for the `PutGeofence` operation (IAM action
 * `geo:PutGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
 * `Effect.provide(AWS.Location.PutGeofenceHttp)`.
 *
 * @binding
 * @section Managing Geofences
 * @example Store a Circular Geofence
 * ```typescript
 * const putGeofence = yield* Location.PutGeofence(collection);
 *
 * yield* putGeofence({
 *   GeofenceId: "warehouse",
 *   Geometry: { Circle: { Center: [-122.3493, 47.6205], Radius: 100 } },
 * });
 * ```
 */
export interface PutGeofence extends Binding.Service<
  PutGeofence,
  "AWS.Location.PutGeofence",
  (
    collection: GeofenceCollection,
  ) => Effect.Effect<
    (
      request: PutGeofenceRequest,
    ) => Effect.Effect<location.PutGeofenceResponse, location.PutGeofenceError>
  >
> {}
export const PutGeofence = Binding.Service<PutGeofence>(
  "AWS.Location.PutGeofence",
);
