import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:ListOrganizationAdminAccounts`.
 *
 * Lists the organization's delegated Security Hub administrator accounts.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.ListOrganizationAdminAccountsHttp)`.
 * @binding
 * @section Members & Organization
 * @example List Delegated Administrators
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listOrganizationAdminAccounts = yield* AWS.SecurityHub.ListOrganizationAdminAccounts();
 *
 * // runtime
 * const { AdminAccounts } = yield* listOrganizationAdminAccounts();
 * ```
 */
export interface ListOrganizationAdminAccounts extends Binding.Service<
  ListOrganizationAdminAccounts,
  "AWS.SecurityHub.ListOrganizationAdminAccounts",
  () => Effect.Effect<
    (
      request?: securityhub.ListOrganizationAdminAccountsRequest,
    ) => Effect.Effect<
      securityhub.ListOrganizationAdminAccountsResponse,
      securityhub.ListOrganizationAdminAccountsError
    >
  >
> {}
export const ListOrganizationAdminAccounts =
  Binding.Service<ListOrganizationAdminAccounts>(
    "AWS.SecurityHub.ListOrganizationAdminAccounts",
  );
