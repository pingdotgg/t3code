import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListAWSServiceAccessForOrganization`.
 *
 * Lists the Amazon Web Services services that are enabled for trusted access with the organization.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListAWSServiceAccessForOrganizationHttp)`.
 * @binding
 * @section Delegated Administration & Trusted Access
 * @example List Trusted-Access Services
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAWSServiceAccessForOrganization = yield* AWS.Organizations.ListAWSServiceAccessForOrganization();
 *
 * // runtime
 * const { EnabledServicePrincipals } =
 *   yield* listAWSServiceAccessForOrganization();
 * ```
 */
export interface ListAWSServiceAccessForOrganization extends Binding.Service<
  ListAWSServiceAccessForOrganization,
  "AWS.Organizations.ListAWSServiceAccessForOrganization",
  () => Effect.Effect<
    (
      request?: organizations.ListAWSServiceAccessForOrganizationRequest,
    ) => Effect.Effect<
      organizations.ListAWSServiceAccessForOrganizationResponse,
      organizations.ListAWSServiceAccessForOrganizationError
    >
  >
> {}
export const ListAWSServiceAccessForOrganization =
  Binding.Service<ListAWSServiceAccessForOrganization>(
    "AWS.Organizations.ListAWSServiceAccessForOrganization",
  );
