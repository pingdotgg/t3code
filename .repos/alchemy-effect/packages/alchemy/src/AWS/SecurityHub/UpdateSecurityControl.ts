import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:UpdateSecurityControl`.
 *
 * Updates the customizable parameters of a security control.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.UpdateSecurityControlHttp)`.
 * @binding
 * @section Standards & Controls
 * @example Tune a Control Parameter
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateSecurityControl = yield* AWS.SecurityHub.UpdateSecurityControl();
 *
 * // runtime
 * yield* updateSecurityControl({
 *   SecurityControlId: "ACM.1",
 *   Parameters: { daysToExpiration: { ValueType: "CUSTOM", Value: { Integer: 15 } } },
 * });
 * ```
 */
export interface UpdateSecurityControl extends Binding.Service<
  UpdateSecurityControl,
  "AWS.SecurityHub.UpdateSecurityControl",
  () => Effect.Effect<
    (
      request?: securityhub.UpdateSecurityControlRequest,
    ) => Effect.Effect<
      securityhub.UpdateSecurityControlResponse,
      securityhub.UpdateSecurityControlError
    >
  >
> {}
export const UpdateSecurityControl = Binding.Service<UpdateSecurityControl>(
  "AWS.SecurityHub.UpdateSecurityControl",
);
