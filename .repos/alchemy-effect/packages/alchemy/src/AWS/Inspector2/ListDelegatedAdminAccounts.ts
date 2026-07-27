import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListDelegatedAdminAccounts`.
 *
 * Lists information about the Amazon Inspector delegated administrator of your organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListDelegatedAdminAccountsHttp)`.
 * @binding
 * @section Organization & Members
 * @example List Delegated Administrators
 * ```typescript
 * // init
 * const listDelegatedAdminAccounts = yield* AWS.Inspector2.ListDelegatedAdminAccounts();
 *
 * // runtime
 * const { delegatedAdminAccounts } = yield* listDelegatedAdminAccounts();
 * ```
 */
export interface ListDelegatedAdminAccounts extends Binding.Service<
  ListDelegatedAdminAccounts,
  "AWS.Inspector2.ListDelegatedAdminAccounts",
  () => Effect.Effect<
    (
      request?: inspector2.ListDelegatedAdminAccountsRequest,
    ) => Effect.Effect<
      inspector2.ListDelegatedAdminAccountsResponse,
      inspector2.ListDelegatedAdminAccountsError
    >
  >
> {}
export const ListDelegatedAdminAccounts =
  Binding.Service<ListDelegatedAdminAccounts>(
    "AWS.Inspector2.ListDelegatedAdminAccounts",
  );
