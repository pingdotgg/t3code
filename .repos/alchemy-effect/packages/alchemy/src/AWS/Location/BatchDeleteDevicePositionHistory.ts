import type * as location from "@distilled.cloud/aws/location";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Tracker } from "./Tracker.ts";

/**
 * `BatchDeleteDevicePositionHistory` request with `TrackerName` injected from the bound
 * resource.
 */
export interface BatchDeleteDevicePositionHistoryRequest extends Omit<
  location.BatchDeleteDevicePositionHistoryRequest,
  "TrackerName"
> {}

/**
 * Deletes the complete position history of up to 100 devices from the tracker.
 *
 * Runtime binding for the `BatchDeleteDevicePositionHistory` operation (IAM action
 * `geo:BatchDeleteDevicePositionHistory`), scoped to one {@link Tracker}. Provide the implementation with
 * `Effect.provide(AWS.Location.BatchDeleteDevicePositionHistoryHttp)`.
 *
 * @binding
 * @section Updating Device Positions
 * @example Purge a Device's Position History
 * ```typescript
 * const deleteHistory = yield* Location.BatchDeleteDevicePositionHistory(tracker);
 *
 * yield* deleteHistory({ DeviceIds: ["vehicle-1"] });
 * ```
 */
export interface BatchDeleteDevicePositionHistory extends Binding.Service<
  BatchDeleteDevicePositionHistory,
  "AWS.Location.BatchDeleteDevicePositionHistory",
  (
    tracker: Tracker,
  ) => Effect.Effect<
    (
      request: BatchDeleteDevicePositionHistoryRequest,
    ) => Effect.Effect<
      location.BatchDeleteDevicePositionHistoryResponse,
      location.BatchDeleteDevicePositionHistoryError
    >
  >
> {}
export const BatchDeleteDevicePositionHistory =
  Binding.Service<BatchDeleteDevicePositionHistory>(
    "AWS.Location.BatchDeleteDevicePositionHistory",
  );
