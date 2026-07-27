import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `detective:DisableOrganizationAdminAccount`.
 *
 * Revokes the organization's delegated Detective administrator. Callable
 * only from the organization management account.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.DisableOrganizationAdminAccountHttp)`.
 * @binding
 * @section Organization Administration
 * @example Revoke The Delegated Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disableOrganizationAdminAccount =
 *   yield* AWS.Detective.DisableOrganizationAdminAccount();
 *
 * // runtime
 * yield* disableOrganizationAdminAccount();
 * ```
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
export const DisableOrganizationAdminAccount =
  Binding.Service<DisableOrganizationAdminAccount>(
    "AWS.Detective.DisableOrganizationAdminAccount",
  );
