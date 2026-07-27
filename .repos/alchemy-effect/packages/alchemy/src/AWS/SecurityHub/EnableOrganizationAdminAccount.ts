import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:EnableOrganizationAdminAccount`.
 *
 * Designates an organization account as the delegated Security Hub administrator.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.EnableOrganizationAdminAccountHttp)`.
 * @binding
 * @section Members & Organization
 * @example Delegate an Organization Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const enableOrganizationAdminAccount = yield* AWS.SecurityHub.EnableOrganizationAdminAccount();
 *
 * // runtime
 * yield* enableOrganizationAdminAccount({ AdminAccountId: "111122223333" });
 * ```
 */
export interface EnableOrganizationAdminAccount extends Binding.Service<
  EnableOrganizationAdminAccount,
  "AWS.SecurityHub.EnableOrganizationAdminAccount",
  () => Effect.Effect<
    (
      request?: securityhub.EnableOrganizationAdminAccountRequest,
    ) => Effect.Effect<
      securityhub.EnableOrganizationAdminAccountResponse,
      securityhub.EnableOrganizationAdminAccountError
    >
  >
> {}
export const EnableOrganizationAdminAccount =
  Binding.Service<EnableOrganizationAdminAccount>(
    "AWS.SecurityHub.EnableOrganizationAdminAccount",
  );
