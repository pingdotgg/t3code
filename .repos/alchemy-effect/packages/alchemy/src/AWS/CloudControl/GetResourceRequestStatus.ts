import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `cloudformation:GetResourceRequestStatus`.
 *
 * Polls the status of an asynchronous Cloud Control operation started with
 * {@link CreateResource}, {@link UpdateResource}, or {@link DeleteResource}
 * until its `OperationStatus` settles (`SUCCESS` / `FAILED` / `CANCEL_COMPLETE`).
 * @binding
 * @section Tracking Requests
 * @example Poll a request token until it settles
 * ```typescript
 * const getResourceRequestStatus =
 *   yield* CloudControl.GetResourceRequestStatus();
 *
 * // runtime — bounded poll every 2s until the operation settles
 * const settled = yield* getResourceRequestStatus({
 *   RequestToken: created.ProgressEvent!.RequestToken!,
 * }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (r): boolean =>
 *       r.ProgressEvent?.OperationStatus !== "PENDING" &&
 *       r.ProgressEvent?.OperationStatus !== "IN_PROGRESS",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface GetResourceRequestStatus extends Binding.Service<
  GetResourceRequestStatus,
  "AWS.CloudControl.GetResourceRequestStatus",
  () => Effect.Effect<
    (
      request: cloudcontrol.GetResourceRequestStatusInput,
    ) => Effect.Effect<
      cloudcontrol.GetResourceRequestStatusOutput,
      cloudcontrol.GetResourceRequestStatusError
    >
  >
> {}

export const GetResourceRequestStatus =
  Binding.Service<GetResourceRequestStatus>(
    "AWS.CloudControl.GetResourceRequestStatus",
  );
