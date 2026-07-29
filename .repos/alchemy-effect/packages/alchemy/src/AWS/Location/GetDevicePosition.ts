import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * `GetDevicePosition` request with `TrackerName` injected from the bound
 * resource.
 */
export interface GetDevicePositionRequest extends Omit<
  location.GetDevicePositionRequest,
  "TrackerName"
> {}

/**
 * Retrieves a device's most recent position reported to the tracker.
 *
 * Runtime binding for the `GetDevicePosition` operation (IAM action
 * `geo:GetDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetDevicePositionHttp)`.
 *
 * @binding
 * @section Reading Device Positions
 * @example Read a Device's Latest Position
 * ```typescript
 * const getPosition = yield* Location.GetDevicePosition(tracker);
 *
 * const latest = yield* getPosition({ DeviceId: "vehicle-1" });
 * // latest.Position → [longitude, latitude]
 * ```
 */
export interface GetDevicePosition extends Binding.Service<
  GetDevicePosition,
  "AWS.Location.GetDevicePosition",
  (
    tracker: Tracker,
  ) => Effect.Effect<
    (
      request: GetDevicePositionRequest,
    ) => Effect.Effect<
      location.GetDevicePositionResponse,
      location.GetDevicePositionError
    >
  >
> {}
export const GetDevicePosition = Binding.Service<GetDevicePosition>(
  "AWS.Location.GetDevicePosition",
);
