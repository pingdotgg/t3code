import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:ListOrganizationAdminAccounts`.
 *
 * Retrieves information about the delegated Amazon Macie administrator account for an organization in Organizations.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.ListOrganizationAdminAccountsHttp)`.
 * @binding
 * @section Organization & Members
 * @example List Delegated Administrators
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listOrganizationAdminAccounts = yield* AWS.Macie2.ListOrganizationAdminAccounts();
 *
 * // runtime
 * const { adminAccounts } = yield* listOrganizationAdminAccounts();
 * ```
 */
export interface ListOrganizationAdminAccounts extends Binding.Service<
  ListOrganizationAdminAccounts,
  "AWS.Macie2.ListOrganizationAdminAccounts",
  () => Effect.Effect<
    (
      request?: macie2.ListOrganizationAdminAccountsRequest,
    ) => Effect.Effect<
      macie2.ListOrganizationAdminAccountsResponse,
      macie2.ListOrganizationAdminAccountsError
    >
  >
> {}
export const ListOrganizationAdminAccounts =
  Binding.Service<ListOrganizationAdminAccounts>(
    "AWS.Macie2.ListOrganizationAdminAccounts",
  );
