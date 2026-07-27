import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetAdministratorAccount`.
 *
 * Returns the details of the Security Hub administrator account for this member account, if any.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetAdministratorAccountHttp)`.
 * @binding
 * @section Members & Organization
 * @example Read the Administrator Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAdministratorAccount = yield* AWS.SecurityHub.GetAdministratorAccount();
 *
 * // runtime
 * const { Administrator } = yield* getAdministratorAccount();
 * ```
 */
export interface GetAdministratorAccount extends Binding.Service<
  GetAdministratorAccount,
  "AWS.SecurityHub.GetAdministratorAccount",
  () => Effect.Effect<
    (
      request?: securityhub.GetAdministratorAccountRequest,
    ) => Effect.Effect<
      securityhub.GetAdministratorAccountResponse,
      securityhub.GetAdministratorAccountError
    >
  >
> {}
export const GetAdministratorAccount = Binding.Service<GetAdministratorAccount>(
  "AWS.SecurityHub.GetAdministratorAccount",
);
