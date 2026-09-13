import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListOrganizationalUnitsForParent`.
 *
 * Lists the organizational units directly contained by the specified root or parent OU.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListOrganizationalUnitsForParentHttp)`.
 * ### Reading the Organization Tree
 * **Example:** List Child OUs
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listOrganizationalUnitsForParent = yield* AWS.Organizations.ListOrganizationalUnitsForParent();
 *
 * // runtime
 * const { OrganizationalUnits } = yield* listOrganizationalUnitsForParent({
 *   ParentId: rootId,
 * });
 * ```
 *
 * @binding
 */
export interface ListOrganizationalUnitsForParent extends Binding.Service<
  ListOrganizationalUnitsForParent,
  "AWS.Organizations.ListOrganizationalUnitsForParent",
  () => Effect.Effect<
    (
      request: organizations.ListOrganizationalUnitsForParentRequest,
    ) => Effect.Effect<
      organizations.ListOrganizationalUnitsForParentResponse,
      organizations.ListOrganizationalUnitsForParentError
    >
  >
> {}
export const ListOrganizationalUnitsForParent =
  Binding.Service<ListOrganizationalUnitsForParent>(
    "AWS.Organizations.ListOrganizationalUnitsForParent",
  );
