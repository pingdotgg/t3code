import type * as detective from "@distilled.cloud/aws/detective";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `detective:DisableOrganizationAdminAccount`.
 *
 * Revokes the organization's delegated Detective administrator. Callable
 * only from the organization management account.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.DisableOrganizationAdminAccountHttp)`.
 * ### Organization Administration
 * **Example:** Revoke The Delegated Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disableOrganizationAdminAccount =
 *   yield* AWS.Detective.DisableOrganizationAdminAccount();
 *
 * // runtime
 * yield* disableOrganizationAdminAccount();
 * ```
 *
 * @binding
 */
export interface DisableOrganizationAdminAccount extends Binding.Service<
  DisableOrganizationAdminAccount,
  "AWS.Detective.DisableOrganizationAdminAccount",
  () => Effect.Effect<
    () => Effect.Effect<
      detective.DisableOrganizationAdminAccountResponse,
      detective.DisableOrganizationAdminAccountError
    >
  >
> {}
export const DisableOrganizationAdminAccount = Binding.Service<DisableOrganizationAdminAccount>(
  "AWS.Detective.DisableOrganizationAdminAccount",
);
