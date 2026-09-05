import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:EnableOrganizationAdminAccount`.
 *
 * Designates an account as the delegated Amazon Macie administrator account for an organization in Organizations.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.EnableOrganizationAdminAccountHttp)`.
 * @binding
 * @section Organization & Members
 * @example Designate the Delegated Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const enableOrganizationAdminAccount = yield* AWS.Macie2.EnableOrganizationAdminAccount();
 *
 * // runtime
 * yield* enableOrganizationAdminAccount({ adminAccountId });
 * ```
 */
export interface EnableOrganizationAdminAccount extends Binding.Service<
  EnableOrganizationAdminAccount,
  "AWS.Macie2.EnableOrganizationAdminAccount",
  () => Effect.Effect<
    (
      request?: macie2.EnableOrganizationAdminAccountRequest,
    ) => Effect.Effect<
      macie2.EnableOrganizationAdminAccountResponse,
      macie2.EnableOrganizationAdminAccountError
    >
  >
> {}
export const EnableOrganizationAdminAccount =
  Binding.Service<EnableOrganizationAdminAccount>(
    "AWS.Macie2.EnableOrganizationAdminAccount",
  );
