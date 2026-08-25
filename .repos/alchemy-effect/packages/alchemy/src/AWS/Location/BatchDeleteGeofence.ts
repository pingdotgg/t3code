import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";

/**
 * `BatchDeleteGeofence` request with `CollectionName` injected from the bound
 * resource.
 */
export interface BatchDeleteGeofenceRequest extends Omit<
  location.BatchDeleteGeofenceRequest,
  "CollectionName"
> {}

/**
 * Deletes up to 10 geofences from the collection in one call.
 *
 * Runtime binding for the `BatchDeleteGeofence` operation (IAM action
 * `geo:BatchDeleteGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
 * `Effect.provide(AWS.Location.BatchDeleteGeofenceHttp)`.
 *
 * @binding
 * @section Managing Geofences
 * @example Delete Geofences
 * ```typescript
 * const batchDelete = yield* Location.BatchDeleteGeofence(collection);
 *
 * yield* batchDelete({ GeofenceIds: ["warehouse"] });
 * ```
 */
export interface BatchDeleteGeofence extends Binding.Service<
  BatchDeleteGeofence,
  "AWS.Location.BatchDeleteGeofence",
  (
    collection: GeofenceCollection,
  ) => Effect.Effect<
    (
      request: BatchDeleteGeofenceRequest,
    ) => Effect.Effect<
      location.BatchDeleteGeofenceResponse,
      location.BatchDeleteGeofenceError
    >
  >
> {}
export const BatchDeleteGeofence = Binding.Service<BatchDeleteGeofence>(
  "AWS.Location.BatchDeleteGeofence",
);
