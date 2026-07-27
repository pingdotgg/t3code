import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListAdminsManagingAccount}.
 */
export interface ListAdminsManagingAccountRequest
  extends fms.ListAdminsManagingAccountRequest {}

/**
 * Runtime binding for `fms:ListAdminsManagingAccount`.
 *
 * Returns the administrators who have the calling account within their administrative scope — usable by any member account to see who manages it. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListAdminsManagingAccountHttp)`.
 * @binding
 * @section Administrator Management
 * @example List the Administrators Managing This Account
 * ```typescript
 * // init — account-level binding takes no resource
 * const listAdminsManagingAccount = yield* AWS.FMS.ListAdminsManagingAccount();
 *
 * // runtime
 * const result = yield* listAdminsManagingAccount();
 * console.log(result.AdminAccounts?.length);
 * ```
 */
export interface ListAdminsManagingAccount extends Binding.Service<
  ListAdminsManagingAccount,
  "AWS.FMS.ListAdminsManagingAccount",
  () => Effect.Effect<
    (
      request?: ListAdminsManagingAccountRequest,
    ) => Effect.Effect<
      fms.ListAdminsManagingAccountResponse,
      fms.ListAdminsManagingAccountError
    >
  >
> {}

export const ListAdminsManagingAccount =
  Binding.Service<ListAdminsManagingAccount>(
    "AWS.FMS.ListAdminsManagingAccount",
  );
