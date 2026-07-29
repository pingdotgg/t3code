import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * `BatchGetDevicePosition` request with `TrackerName` injected from the bound
 * resource.
 */
export interface BatchGetDevicePositionRequest extends Omit<
  location.BatchGetDevicePositionRequest,
  "TrackerName"
> {}

/**
 * Retrieves the latest position for up to 10 devices from the tracker in one call.
 *
 * Runtime binding for the `BatchGetDevicePosition` operation (IAM action
 * `geo:BatchGetDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
 * `Effect.provide(AWS.Location.BatchGetDevicePositionHttp)`.
 *
 * @binding
 * @section Reading Device Positions
 * @example Read Several Devices at Once
 * ```typescript
 * const batchGet = yield* Location.BatchGetDevicePosition(tracker);
 *
 * const result = yield* batchGet({ DeviceIds: ["vehicle-1", "vehicle-2"] });
 * // result.DevicePositions → found positions, result.Errors → per-device failures
 * ```
 */
export interface BatchGetDevicePosition extends Binding.Service<
  BatchGetDevicePosition,
  "AWS.Location.BatchGetDevicePosition",
  (
    tracker: Tracker,
  ) => Effect.Effect<
    (
      request: BatchGetDevicePositionRequest,
    ) => Effect.Effect<
      location.BatchGetDevicePositionResponse,
      location.BatchGetDevicePositionError
    >
  >
> {}
export const BatchGetDevicePosition = Binding.Service<BatchGetDevicePosition>(
  "AWS.Location.BatchGetDevicePosition",
);
