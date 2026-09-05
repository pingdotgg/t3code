import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `detective:EnableOrganizationAdminAccount`.
 *
 * Designates an organization account as the delegated Detective
 * administrator. Callable only from the organization management account —
 * the org-governance automation hook.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.EnableOrganizationAdminAccountHttp)`.
 * @binding
 * @section Organization Administration
 * @example Delegate The Security Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const enableOrganizationAdminAccount =
 *   yield* AWS.Detective.EnableOrganizationAdminAccount();
 *
 * // runtime
 * yield* enableOrganizationAdminAccount({ AccountId: securityAccountId });
 * ```
 */
export interface EnableOrganizationAdminAccount extends Binding.Service<
  EnableOrganizationAdminAccount,
  "AWS.Detective.EnableOrganizationAdminAccount",
  () => Effect.Effect<
    (
      request: detective.EnableOrganizationAdminAccountRequest,
    ) => Effect.Effect<
      detective.EnableOrganizationAdminAccountResponse,
      detective.EnableOrganizationAdminAccountError
    >
  >
> {}
export const EnableOrganizationAdminAccount =
  Binding.Service<EnableOrganizationAdminAccount>(
    "AWS.Detective.EnableOrganizationAdminAccount",
  );
