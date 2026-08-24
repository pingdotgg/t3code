import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * `BatchUpdateDevicePosition` request with `TrackerName` injected from the bound
 * resource.
 */
export interface BatchUpdateDevicePositionRequest extends Omit<
  location.BatchUpdateDevicePositionRequest,
  "TrackerName"
> {}

/**
 * Uploads position updates for up to 10 devices to the tracker (also triggers geofence evaluation for linked collections).
 *
 * Runtime binding for the `BatchUpdateDevicePosition` operation (IAM action
 * `geo:BatchUpdateDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
 * `Effect.provide(AWS.Location.BatchUpdateDevicePositionHttp)`.
 *
 * @binding
 * @section Updating Device Positions
 * @example Report Device Positions
 * ```typescript
 * const updatePositions = yield* Location.BatchUpdateDevicePosition(tracker);
 *
 * yield* updatePositions({
 *   Updates: [
 *     {
 *       DeviceId: "vehicle-1",
 *       Position: [-122.3493, 47.6205], // [longitude, latitude]
 *       SampleTime: new Date(),
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchUpdateDevicePosition extends Binding.Service<
  BatchUpdateDevicePosition,
  "AWS.Location.BatchUpdateDevicePosition",
  (
    tracker: Tracker,
  ) => Effect.Effect<
    (
      request: BatchUpdateDevicePositionRequest,
    ) => Effect.Effect<
      location.BatchUpdateDevicePositionResponse,
      location.BatchUpdateDevicePositionError
    >
  >
> {}
export const BatchUpdateDevicePosition =
  Binding.Service<BatchUpdateDevicePosition>(
    "AWS.Location.BatchUpdateDevicePosition",
  );
