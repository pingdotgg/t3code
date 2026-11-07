import type * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `guardduty:DisableOrganizationAdminAccount`.
 *
 * Removes an account's delegation as the organization's GuardDuty administrator (management account only).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.DisableOrganizationAdminAccountHttp)`.
 * ### Organization Administration
 * **Example:** Remove a Delegated Administrator
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const disableOrganizationAdminAccount = yield* AWS.GuardDuty.DisableOrganizationAdminAccount();
 *
 * // runtime
 * yield* disableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
 * ```
 *
 * @binding
 */
export interface DisableOrganizationAdminAccount extends Binding.Service<
  DisableOrganizationAdminAccount,
  "AWS.GuardDuty.DisableOrganizationAdminAccount",
  () => Effect.Effect<
    (
      request?: guardduty.DisableOrganizationAdminAccountRequest,
    ) => Effect.Effect<
      guardduty.DisableOrganizationAdminAccountResponse,
      guardduty.DisableOrganizationAdminAccountError
    >
  >
> {}
export const DisableOrganizationAdminAccount = Binding.Service<DisableOrganizationAdminAccount>(
  "AWS.GuardDuty.DisableOrganizationAdminAccount",
);
