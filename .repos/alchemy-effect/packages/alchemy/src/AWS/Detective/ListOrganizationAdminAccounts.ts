import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `detective:ListOrganizationAdminAccounts`.
 *
 * Lists the organization's delegated Detective administrator account.
 * Callable only from the organization management account.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.ListOrganizationAdminAccountsHttp)`.
 * @binding
 * @section Organization Administration
 * @example Find The Delegated Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listOrganizationAdminAccounts =
 *   yield* AWS.Detective.ListOrganizationAdminAccounts();
 *
 * // runtime
 * const { Administrators } = yield* listOrganizationAdminAccounts();
 * ```
 */
export interface ListOrganizationAdminAccounts extends Binding.Service<
  ListOrganizationAdminAccounts,
  "AWS.Detective.ListOrganizationAdminAccounts",
  () => Effect.Effect<
    (
      request?: detective.ListOrganizationAdminAccountsRequest,
    ) => Effect.Effect<
      detective.ListOrganizationAdminAccountsResponse,
      detective.ListOrganizationAdminAccountsError
    >
  >
> {}
export const ListOrganizationAdminAccounts =
  Binding.Service<ListOrganizationAdminAccounts>(
    "AWS.Detective.ListOrganizationAdminAccounts",
  );
