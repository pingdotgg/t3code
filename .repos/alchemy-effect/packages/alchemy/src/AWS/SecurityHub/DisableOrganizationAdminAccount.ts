import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DisableOrganizationAdminAccount`.
 *
 * Removes an organization account's delegated Security Hub administrator status.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DisableOrganizationAdminAccountHttp)`.
 * @binding
 * @section Members & Organization
 * @example Remove the Delegated Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disableOrganizationAdminAccount = yield* AWS.SecurityHub.DisableOrganizationAdminAccount();
 *
 * // runtime
 * yield* disableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
 * ```
 */
export interface DisableOrganizationAdminAccount extends Binding.Service<
  DisableOrganizationAdminAccount,
  "AWS.SecurityHub.DisableOrganizationAdminAccount",
  () => Effect.Effect<
    (
      request?: securityhub.DisableOrganizationAdminAccountRequest,
    ) => Effect.Effect<
      securityhub.DisableOrganizationAdminAccountResponse,
      securityhub.DisableOrganizationAdminAccountError
    >
  >
> {}
export const DisableOrganizationAdminAccount =
  Binding.Service<DisableOrganizationAdminAccount>(
    "AWS.SecurityHub.DisableOrganizationAdminAccount",
  );
