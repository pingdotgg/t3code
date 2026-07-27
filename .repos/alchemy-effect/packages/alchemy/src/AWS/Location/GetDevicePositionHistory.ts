import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * `GetDevicePositionHistory` request with `TrackerName` injected from the bound
 * resource.
 */
export interface GetDevicePositionHistoryRequest extends Omit<
  location.GetDevicePositionHistoryRequest,
  "TrackerName"
> {}

/**
 * Retrieves the position history of a device from the tracker (positions are retained for 30 days).
 *
 * Runtime binding for the `GetDevicePositionHistory` operation (IAM action
 * `geo:GetDevicePositionHistory`), scoped to one {@link Tracker}. Provide the implementation with
 * `Effect.provide(AWS.Location.GetDevicePositionHistoryHttp)`.
 *
 * @binding
 * @section Reading Device Positions
 * @example Read a Device's Position History
 * ```typescript
 * const getHistory = yield* Location.GetDevicePositionHistory(tracker);
 *
 * const history = yield* getHistory({ DeviceId: "vehicle-1" });
 * // history.DevicePositions → chronological position samples
 * ```
 */
export interface GetDevicePositionHistory extends Binding.Service<
  GetDevicePositionHistory,
  "AWS.Location.GetDevicePositionHistory",
  (
    tracker: Tracker,
  ) => Effect.Effect<
    (
      request: GetDevicePositionHistoryRequest,
    ) => Effect.Effect<
      location.GetDevicePositionHistoryResponse,
      location.GetDevicePositionHistoryError
    >
  >
> {}
export const GetDevicePositionHistory =
  Binding.Service<GetDevicePositionHistory>(
    "AWS.Location.GetDevicePositionHistory",
  );
