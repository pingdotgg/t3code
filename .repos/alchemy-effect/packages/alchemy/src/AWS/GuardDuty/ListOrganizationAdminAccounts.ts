import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `guardduty:ListOrganizationAdminAccounts`.
 *
 * Lists the accounts delegated as GuardDuty administrator for the organization.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ListOrganizationAdminAccountsHttp)`.
 * @binding
 * @section Organization Administration
 * @example List Delegated Administrators
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const listOrganizationAdminAccounts = yield* AWS.GuardDuty.ListOrganizationAdminAccounts();
 *
 * // runtime
 * const { AdminAccounts } = yield* listOrganizationAdminAccounts();
 * ```
 */
export interface ListOrganizationAdminAccounts extends Binding.Service<
  ListOrganizationAdminAccounts,
  "AWS.GuardDuty.ListOrganizationAdminAccounts",
  () => Effect.Effect<
    (
      request?: guardduty.ListOrganizationAdminAccountsRequest,
    ) => Effect.Effect<
      guardduty.ListOrganizationAdminAccountsResponse,
      guardduty.ListOrganizationAdminAccountsError
    >
  >
> {}
export const ListOrganizationAdminAccounts =
  Binding.Service<ListOrganizationAdminAccounts>(
    "AWS.GuardDuty.ListOrganizationAdminAccounts",
  );
