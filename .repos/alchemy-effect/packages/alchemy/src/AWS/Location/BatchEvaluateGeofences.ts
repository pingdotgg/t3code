import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";

/**
 * `BatchEvaluateGeofences` request with `CollectionName` injected from the bound
 * resource.
 */
export interface BatchEvaluateGeofencesRequest extends Omit<
  location.BatchEvaluateGeofencesRequest,
  "CollectionName"
> {}

/**
 * Evaluates device positions against the collection's geofences, emitting ENTER/EXIT events to EventBridge for linked trackers.
 *
 * Runtime binding for the `BatchEvaluateGeofences` operation (IAM action
 * `geo:BatchEvaluateGeofences`), scoped to one {@link GeofenceCollection}. Provide the implementation with
 * `Effect.provide(AWS.Location.BatchEvaluateGeofencesHttp)`.
 *
 * @binding
 * @section Evaluating Positions Against Geofences
 * @example Evaluate Positions
 * ```typescript
 * const evaluate = yield* Location.BatchEvaluateGeofences(collection);
 *
 * yield* evaluate({
 *   DevicePositionUpdates: [
 *     {
 *       DeviceId: "vehicle-1",
 *       Position: [-122.3493, 47.6205],
 *       SampleTime: new Date(),
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchEvaluateGeofences extends Binding.Service<
  BatchEvaluateGeofences,
  "AWS.Location.BatchEvaluateGeofences",
  (
    collection: GeofenceCollection,
  ) => Effect.Effect<
    (
      request: BatchEvaluateGeofencesRequest,
    ) => Effect.Effect<
      location.BatchEvaluateGeofencesResponse,
      location.BatchEvaluateGeofencesError
    >
  >
> {}
export const BatchEvaluateGeofences = Binding.Service<BatchEvaluateGeofences>(
  "AWS.Location.BatchEvaluateGeofences",
);
