import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListMemberAccounts}.
 */
export interface ListMemberAccountsRequest
  extends fms.ListMemberAccountsRequest {}

/**
 * Runtime binding for `fms:ListMemberAccounts`.
 *
 * Returns the member account ids in the administrator's Amazon Web Services organization — only usable by the organization's management account or a delegated administrator. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListMemberAccountsHttp)`.
 * @binding
 * @section Compliance and Protection Status
 * @example List Member Accounts
 * ```typescript
 * // init — account-level binding takes no resource
 * const listMemberAccounts = yield* AWS.FMS.ListMemberAccounts();
 *
 * // runtime
 * const result = yield* listMemberAccounts();
 * console.log(result.MemberAccounts?.length);
 * ```
 */
export interface ListMemberAccounts extends Binding.Service<
  ListMemberAccounts,
  "AWS.FMS.ListMemberAccounts",
  () => Effect.Effect<
    (
      request?: ListMemberAccountsRequest,
    ) => Effect.Effect<
      fms.ListMemberAccountsResponse,
      fms.ListMemberAccountsError
    >
  >
> {}

export const ListMemberAccounts = Binding.Service<ListMemberAccounts>(
  "AWS.FMS.ListMemberAccounts",
);
