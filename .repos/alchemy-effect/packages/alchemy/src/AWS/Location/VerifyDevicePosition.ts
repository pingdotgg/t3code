import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * `VerifyDevicePosition` request with `TrackerName` injected from the bound
 * resource.
 */
export interface VerifyDevicePositionRequest extends Omit<
  location.VerifyDevicePositionRequest,
  "TrackerName"
> {}

/**
 * Verifies a reported device position against cellular, Wi-Fi, and IP signals to detect spoofed GPS locations.
 *
 * Runtime binding for the `VerifyDevicePosition` operation (IAM action
 * `geo:VerifyDevicePosition`), scoped to one {@link Tracker}. Provide the implementation with
 * `Effect.provide(AWS.Location.VerifyDevicePositionHttp)`.
 *
 * @binding
 * @section Verifying Device Positions
 * @example Verify a Position Against Wi-Fi Signals
 * ```typescript
 * const verifyPosition = yield* Location.VerifyDevicePosition(tracker);
 *
 * const verdict = yield* verifyPosition({
 *   DeviceState: {
 *     DeviceId: "vehicle-1",
 *     SampleTime: new Date(),
 *     Position: [-122.3493, 47.6205],
 *     WiFiAccessPoints: [{ MacAddress: "A0:EC:F9:1E:32:C1", Rss: -66 }],
 *   },
 * });
 * // verdict.InferredState → inferred position + accuracy
 * ```
 */
export interface VerifyDevicePosition extends Binding.Service<
  VerifyDevicePosition,
  "AWS.Location.VerifyDevicePosition",
  (
    tracker: Tracker,
  ) => Effect.Effect<
    (
      request: VerifyDevicePositionRequest,
    ) => Effect.Effect<
      location.VerifyDevicePositionResponse,
      location.VerifyDevicePositionError
    >
  >
> {}
export const VerifyDevicePosition = Binding.Service<VerifyDevicePosition>(
  "AWS.Location.VerifyDevicePosition",
);
