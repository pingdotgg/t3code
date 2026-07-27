import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:EnableDelegatedAdminAccount`.
 *
 * Enables the Amazon Inspector delegated administrator for your Organizations organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.EnableDelegatedAdminAccountHttp)`.
 * @binding
 * @section Organization & Members
 * @example Enable a Delegated Administrator
 * ```typescript
 * // init
 * const enableDelegatedAdminAccount = yield* AWS.Inspector2.EnableDelegatedAdminAccount();
 *
 * // runtime
 * yield* enableDelegatedAdminAccount({ delegatedAdminAccountId });
 * ```
 */
export interface EnableDelegatedAdminAccount extends Binding.Service<
  EnableDelegatedAdminAccount,
  "AWS.Inspector2.EnableDelegatedAdminAccount",
  () => Effect.Effect<
    (
      request: inspector2.EnableDelegatedAdminAccountRequest,
    ) => Effect.Effect<
      inspector2.EnableDelegatedAdminAccountResponse,
      inspector2.EnableDelegatedAdminAccountError
    >
  >
> {}
export const EnableDelegatedAdminAccount =
  Binding.Service<EnableDelegatedAdminAccount>(
    "AWS.Inspector2.EnableDelegatedAdminAccount",
  );
