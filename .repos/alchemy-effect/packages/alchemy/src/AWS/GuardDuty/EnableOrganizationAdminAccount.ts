import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `guardduty:EnableOrganizationAdminAccount`.
 *
 * Delegates an account as the organization's GuardDuty administrator (management account only).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.EnableOrganizationAdminAccountHttp)`.
 * @binding
 * @section Organization Administration
 * @example Delegate an Administrator
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const enableOrganizationAdminAccount = yield* AWS.GuardDuty.EnableOrganizationAdminAccount();
 *
 * // runtime
 * yield* enableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
 * ```
 */
export interface EnableOrganizationAdminAccount extends Binding.Service<
  EnableOrganizationAdminAccount,
  "AWS.GuardDuty.EnableOrganizationAdminAccount",
  () => Effect.Effect<
    (
      request?: guardduty.EnableOrganizationAdminAccountRequest,
    ) => Effect.Effect<
      guardduty.EnableOrganizationAdminAccountResponse,
      guardduty.EnableOrganizationAdminAccountError
    >
  >
> {}
export const EnableOrganizationAdminAccount =
  Binding.Service<EnableOrganizationAdminAccount>(
    "AWS.GuardDuty.EnableOrganizationAdminAccount",
  );
