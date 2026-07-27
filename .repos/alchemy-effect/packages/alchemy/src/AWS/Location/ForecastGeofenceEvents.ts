import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GeofenceCollection } from "./GeofenceCollection.ts";

/**
 * `ForecastGeofenceEvents` request with `CollectionName` injected from the bound
 * resource.
 */
export interface ForecastGeofenceEventsRequest extends Omit<
  location.ForecastGeofenceEventsRequest,
  "CollectionName"
> {}

/**
 * Forecasts which geofences a device will enter or exit given its position and speed.
 *
 * Runtime binding for the `ForecastGeofenceEvents` operation (IAM action
 * `geo:ForecastGeofenceEvents`), scoped to one {@link GeofenceCollection}. Provide the implementation with
 * `Effect.provide(AWS.Location.ForecastGeofenceEventsHttp)`.
 *
 * @binding
 * @section Evaluating Positions Against Geofences
 * @example Forecast Upcoming Geofence Events
 * ```typescript
 * const forecast = yield* Location.ForecastGeofenceEvents(collection);
 *
 * const events = yield* forecast({
 *   DeviceState: { Position: [-122.3493, 47.6205], Speed: 20 },
 *   TimeHorizonMinutes: 30,
 * });
 * // events.ForecastedEvents → [{ GeofenceId, EventType, NearestDistance }, …]
 * ```
 */
export interface ForecastGeofenceEvents extends Binding.Service<
  ForecastGeofenceEvents,
  "AWS.Location.ForecastGeofenceEvents",
  (
    collection: GeofenceCollection,
  ) => Effect.Effect<
    (
      request: ForecastGeofenceEventsRequest,
    ) => Effect.Effect<
      location.ForecastGeofenceEventsResponse,
      location.ForecastGeofenceEventsError
    >
  >
> {}
export const ForecastGeofenceEvents = Binding.Service<ForecastGeofenceEvents>(
  "AWS.Location.ForecastGeofenceEvents",
);
