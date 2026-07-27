import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetViolationDetails}.
 */
export interface GetViolationDetailsRequest
  extends fms.GetViolationDetailsRequest {}

/**
 * Runtime binding for `fms:GetViolationDetails`.
 *
 * Returns violation details for the specified resource covered by a Firewall Manager network ACL, security group, Network Firewall, DNS Firewall, or third-party firewall policy. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetViolationDetailsHttp)`.
 * @binding
 * @section Compliance and Protection Status
 * @example Read a Resource's Violation Details
 * ```typescript
 * // init — account-level binding takes no resource
 * const getViolationDetails = yield* AWS.FMS.GetViolationDetails();
 *
 * // runtime
 * const result = yield* getViolationDetails({
 *   PolicyId: policyId,
 *   MemberAccount: accountId,
 *   ResourceId: instanceId,
 *   ResourceType: "AWS::EC2::Instance",
 * });
 * console.log(result.ViolationDetail?.ResourceViolations.length);
 * ```
 */
export interface GetViolationDetails extends Binding.Service<
  GetViolationDetails,
  "AWS.FMS.GetViolationDetails",
  () => Effect.Effect<
    (
      request: GetViolationDetailsRequest,
    ) => Effect.Effect<
      fms.GetViolationDetailsResponse,
      fms.GetViolationDetailsError
    >
  >
> {}

export const GetViolationDetails = Binding.Service<GetViolationDetails>(
  "AWS.FMS.GetViolationDetails",
);
