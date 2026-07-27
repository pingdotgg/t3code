import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:DisableDelegatedAdminAccount`.
 *
 * Disables the Amazon Inspector delegated administrator for your organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.DisableDelegatedAdminAccountHttp)`.
 * @binding
 * @section Organization & Members
 * @example Disable a Delegated Administrator
 * ```typescript
 * // init
 * const disableDelegatedAdminAccount = yield* AWS.Inspector2.DisableDelegatedAdminAccount();
 *
 * // runtime
 * yield* disableDelegatedAdminAccount({ delegatedAdminAccountId });
 * ```
 */
export interface DisableDelegatedAdminAccount extends Binding.Service<
  DisableDelegatedAdminAccount,
  "AWS.Inspector2.DisableDelegatedAdminAccount",
  () => Effect.Effect<
    (
      request: inspector2.DisableDelegatedAdminAccountRequest,
    ) => Effect.Effect<
      inspector2.DisableDelegatedAdminAccountResponse,
      inspector2.DisableDelegatedAdminAccountError
    >
  >
> {}
export const DisableDelegatedAdminAccount =
  Binding.Service<DisableDelegatedAdminAccount>(
    "AWS.Inspector2.DisableDelegatedAdminAccount",
  );
