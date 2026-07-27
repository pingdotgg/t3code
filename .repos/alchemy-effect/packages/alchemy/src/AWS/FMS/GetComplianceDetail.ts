import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetComplianceDetail}.
 */
export interface GetComplianceDetailRequest
  extends fms.GetComplianceDetailRequest {}

/**
 * Runtime binding for `fms:GetComplianceDetail`.
 *
 * Returns detailed compliance information about the specified member account — the resources that are in and out of compliance with the specified policy. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetComplianceDetailHttp)`.
 * @binding
 * @section Compliance and Protection Status
 * @example Read a Member Account's Compliance Detail
 * ```typescript
 * // init — account-level binding takes no resource
 * const getComplianceDetail = yield* AWS.FMS.GetComplianceDetail();
 *
 * // runtime
 * const result = yield* getComplianceDetail({
 *   PolicyId: policyId,
 *   MemberAccount: accountId,
 * });
 * console.log(result.PolicyComplianceDetail?.Violators?.length);
 * ```
 */
export interface GetComplianceDetail extends Binding.Service<
  GetComplianceDetail,
  "AWS.FMS.GetComplianceDetail",
  () => Effect.Effect<
    (
      request: GetComplianceDetailRequest,
    ) => Effect.Effect<
      fms.GetComplianceDetailResponse,
      fms.GetComplianceDetailError
    >
  >
> {}

export const GetComplianceDetail = Binding.Service<GetComplianceDetail>(
  "AWS.FMS.GetComplianceDetail",
);
