import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * `ListDevicePositions` request with `TrackerName` injected from the bound
 * resource.
 */
export interface ListDevicePositionsRequest extends Omit<
  location.ListDevicePositionsRequest,
  "TrackerName"
> {}

/**
 * Lists the latest position of every device reported to the tracker, optionally filtered by a polygon.
 *
 * Runtime binding for the `ListDevicePositions` operation (IAM action
 * `geo:ListDevicePositions`), scoped to one {@link Tracker}. Provide the implementation with
 * `Effect.provide(AWS.Location.ListDevicePositionsHttp)`.
 *
 * @binding
 * @section Reading Device Positions
 * @example List All Device Positions
 * ```typescript
 * const listPositions = yield* Location.ListDevicePositions(tracker);
 *
 * const page = yield* listPositions();
 * // page.Entries → [{ DeviceId, Position, SampleTime }, …]
 * ```
 */
export interface ListDevicePositions extends Binding.Service<
  ListDevicePositions,
  "AWS.Location.ListDevicePositions",
  (
    tracker: Tracker,
  ) => Effect.Effect<
    (
      request?: ListDevicePositionsRequest,
    ) => Effect.Effect<
      location.ListDevicePositionsResponse,
      location.ListDevicePositionsError
    >
  >
> {}
export const ListDevicePositions = Binding.Service<ListDevicePositions>(
  "AWS.Location.ListDevicePositions",
);
