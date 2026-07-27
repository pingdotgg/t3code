import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetProtectionStatus}.
 */
export interface GetProtectionStatusRequest
  extends fms.GetProtectionStatusRequest {}

/**
 * Runtime binding for `fms:GetProtectionStatus`.
 *
 * Returns policy-level attack summary information for Shield Advanced policies — DDoS attacks detected during the specified time period. Provide the
 * implementation with `Effect.provide(AWS.FMS.GetProtectionStatusHttp)`.
 * @binding
 * @section Compliance and Protection Status
 * @example Read a Shield Policy's Protection Status
 * ```typescript
 * // init — account-level binding takes no resource
 * const getProtectionStatus = yield* AWS.FMS.GetProtectionStatus();
 *
 * // runtime
 * const result = yield* getProtectionStatus({ PolicyId: policyId });
 * console.log(result.ServiceType, result.Data);
 * ```
 */
export interface GetProtectionStatus extends Binding.Service<
  GetProtectionStatus,
  "AWS.FMS.GetProtectionStatus",
  () => Effect.Effect<
    (
      request: GetProtectionStatusRequest,
    ) => Effect.Effect<
      fms.GetProtectionStatusResponse,
      fms.GetProtectionStatusError
    >
  >
> {}

export const GetProtectionStatus = Binding.Service<GetProtectionStatus>(
  "AWS.FMS.GetProtectionStatus",
);
