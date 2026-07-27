import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListAdminAccountsForOrganization}.
 */
export interface ListAdminAccountsForOrganizationRequest
  extends fms.ListAdminAccountsForOrganizationRequest {}

/**
 * Runtime binding for `fms:ListAdminAccountsForOrganization`.
 *
 * Returns the Firewall Manager administrator accounts in the organization — only usable by the organization's management account. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListAdminAccountsForOrganizationHttp)`.
 * @binding
 * @section Administrator Management
 * @example List the Organization's Administrators
 * ```typescript
 * // init — account-level binding takes no resource
 * const listAdminAccountsForOrganization = yield* AWS.FMS.ListAdminAccountsForOrganization();
 *
 * // runtime
 * const result = yield* listAdminAccountsForOrganization();
 * console.log(result.AdminAccounts?.length);
 * ```
 */
export interface ListAdminAccountsForOrganization extends Binding.Service<
  ListAdminAccountsForOrganization,
  "AWS.FMS.ListAdminAccountsForOrganization",
  () => Effect.Effect<
    (
      request?: ListAdminAccountsForOrganizationRequest,
    ) => Effect.Effect<
      fms.ListAdminAccountsForOrganizationResponse,
      fms.ListAdminAccountsForOrganizationError
    >
  >
> {}

export const ListAdminAccountsForOrganization =
  Binding.Service<ListAdminAccountsForOrganization>(
    "AWS.FMS.ListAdminAccountsForOrganization",
  );
