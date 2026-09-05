import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `cloudformation:CancelResourceRequest`.
 *
 * Cancels a resource operation request that is still `PENDING` or
 * `IN_PROGRESS` — the companion to {@link CreateResource} /
 * {@link UpdateResource} / {@link DeleteResource} for aborting slow or
 * mistaken provisioning operations.
 * @binding
 * @section Tracking Requests
 * @example Cancel an in-flight operation
 * ```typescript
 * const cancelResourceRequest = yield* CloudControl.CancelResourceRequest();
 *
 * // runtime
 * yield* cancelResourceRequest({
 *   RequestToken: created.ProgressEvent!.RequestToken!,
 * });
 * ```
 */
export interface CancelResourceRequest extends Binding.Service<
  CancelResourceRequest,
  "AWS.CloudControl.CancelResourceRequest",
  () => Effect.Effect<
    (
      request: cloudcontrol.CancelResourceRequestInput,
    ) => Effect.Effect<
      cloudcontrol.CancelResourceRequestOutput,
      cloudcontrol.CancelResourceRequestError
    >
  >
> {}

export const CancelResourceRequest = Binding.Service<CancelResourceRequest>(
  "AWS.CloudControl.CancelResourceRequest",
);
