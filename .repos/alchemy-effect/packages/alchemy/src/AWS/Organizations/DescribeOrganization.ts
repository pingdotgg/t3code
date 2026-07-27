import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:DescribeOrganization`.
 *
 * Retrieves information about the organization that the calling account belongs to — its id, ARN, feature set, and management account. Available from any account in the organization.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.DescribeOrganizationHttp)`.
 * @binding
 * @section Reading the Organization Tree
 * @example Read the Organization
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeOrganization = yield* AWS.Organizations.DescribeOrganization();
 *
 * // runtime
 * const { Organization } = yield* describeOrganization();
 * console.log(Organization?.Id, Organization?.MasterAccountId);
 * ```
 */
export interface DescribeOrganization extends Binding.Service<
  DescribeOrganization,
  "AWS.Organizations.DescribeOrganization",
  () => Effect.Effect<
    (
      request?: organizations.DescribeOrganizationRequest,
    ) => Effect.Effect<
      organizations.DescribeOrganizationResponse,
      organizations.DescribeOrganizationError
    >
  >
> {}
export const DescribeOrganization = Binding.Service<DescribeOrganization>(
  "AWS.Organizations.DescribeOrganization",
);
