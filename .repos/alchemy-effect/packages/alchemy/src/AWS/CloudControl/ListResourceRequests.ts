import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `cloudformation:ListResourceRequests`.
 *
 * Lists resource operation requests made in the account and Region over the
 * last 7 days — useful for surfacing in-flight or failed provisioning
 * operations from a management Function.
 * @binding
 * @section Tracking Requests
 * @example List in-progress operations
 * ```typescript
 * const listResourceRequests = yield* CloudControl.ListResourceRequests();
 *
 * // runtime
 * const page = yield* listResourceRequests({
 *   ResourceRequestStatusFilter: { OperationStatuses: ["IN_PROGRESS"] },
 *   MaxResults: 20,
 * });
 * ```
 */
export interface ListResourceRequests extends Binding.Service<
  ListResourceRequests,
  "AWS.CloudControl.ListResourceRequests",
  () => Effect.Effect<
    (
      request?: cloudcontrol.ListResourceRequestsInput,
    ) => Effect.Effect<
      cloudcontrol.ListResourceRequestsOutput,
      cloudcontrol.ListResourceRequestsError
    >
  >
> {}

export const ListResourceRequests = Binding.Service<ListResourceRequests>(
  "AWS.CloudControl.ListResourceRequests",
);
