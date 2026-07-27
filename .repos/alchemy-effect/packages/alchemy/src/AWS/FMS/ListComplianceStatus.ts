import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListComplianceStatus}.
 */
export interface ListComplianceStatusRequest
  extends fms.ListComplianceStatusRequest {}

/**
 * Runtime binding for `fms:ListComplianceStatus`.
 *
 * Returns an array of `PolicyComplianceStatus` objects — use it to get a summary of which member accounts are protected by the specified policy. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListComplianceStatusHttp)`.
 * @binding
 * @section Compliance and Protection Status
 * @example List a Policy's Compliance Status
 * ```typescript
 * // init — account-level binding takes no resource
 * const listComplianceStatus = yield* AWS.FMS.ListComplianceStatus();
 *
 * // runtime
 * const result = yield* listComplianceStatus({ PolicyId: policyId });
 * console.log(result.PolicyComplianceStatusList?.length);
 * ```
 */
export interface ListComplianceStatus extends Binding.Service<
  ListComplianceStatus,
  "AWS.FMS.ListComplianceStatus",
  () => Effect.Effect<
    (
      request: ListComplianceStatusRequest,
    ) => Effect.Effect<
      fms.ListComplianceStatusResponse,
      fms.ListComplianceStatusError
    >
  >
> {}

export const ListComplianceStatus = Binding.Service<ListComplianceStatus>(
  "AWS.FMS.ListComplianceStatus",
);
