import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetDelegatedAdminAccount`.
 *
 * Retrieves information about the Amazon Inspector delegated administrator for your
 * organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetDelegatedAdminAccountHttp)`.
 * @binding
 * @section Organization & Members
 * @example Get the Delegated Administrator
 * ```typescript
 * // init
 * const getDelegatedAdminAccount = yield* AWS.Inspector2.GetDelegatedAdminAccount();
 *
 * // runtime
 * const { delegatedAdmin } = yield* getDelegatedAdminAccount();
 * ```
 */
export interface GetDelegatedAdminAccount extends Binding.Service<
  GetDelegatedAdminAccount,
  "AWS.Inspector2.GetDelegatedAdminAccount",
  () => Effect.Effect<
    (
      request: inspector2.GetDelegatedAdminAccountRequest,
    ) => Effect.Effect<
      inspector2.GetDelegatedAdminAccountResponse,
      inspector2.GetDelegatedAdminAccountError
    >
  >
> {}
export const GetDelegatedAdminAccount =
  Binding.Service<GetDelegatedAdminAccount>(
    "AWS.Inspector2.GetDelegatedAdminAccount",
  );
