import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";

/**
 * `BatchPutGeofence` request with `CollectionName` injected from the bound
 * resource.
 */
export interface BatchPutGeofenceRequest extends Omit<
  location.BatchPutGeofenceRequest,
  "CollectionName"
> {}

/**
 * Stores up to 10 geofences in the collection in one call.
 *
 * Runtime binding for the `BatchPutGeofence` operation (IAM action
 * `geo:BatchPutGeofence`), scoped to one {@link GeofenceCollection}. Provide the implementation with
 * `Effect.provide(AWS.Location.BatchPutGeofenceHttp)`.
 *
 * @binding
 * @section Managing Geofences
 * @example Store Several Geofences at Once
 * ```typescript
 * const batchPut = yield* Location.BatchPutGeofence(collection);
 *
 * const result = yield* batchPut({
 *   Entries: [
 *     {
 *       GeofenceId: "warehouse",
 *       Geometry: { Circle: { Center: [-122.3493, 47.6205], Radius: 100 } },
 *     },
 *   ],
 * });
 * // result.Successes / result.Errors → per-geofence outcomes
 * ```
 */
export interface BatchPutGeofence extends Binding.Service<
  BatchPutGeofence,
  "AWS.Location.BatchPutGeofence",
  (
    collection: GeofenceCollection,
  ) => Effect.Effect<
    (
      request: BatchPutGeofenceRequest,
    ) => Effect.Effect<
      location.BatchPutGeofenceResponse,
      location.BatchPutGeofenceError
    >
  >
> {}
export const BatchPutGeofence = Binding.Service<BatchPutGeofence>(
  "AWS.Location.BatchPutGeofence",
);
