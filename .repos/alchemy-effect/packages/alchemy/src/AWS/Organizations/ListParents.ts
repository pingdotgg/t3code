import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListParents`.
 *
 * Lists the direct parent (root or OU) of the specified child account or OU — walking the organization tree upward.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListParentsHttp)`.
 * @binding
 * @section Reading the Organization Tree
 * @example Find an Account's Parent
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listParents = yield* AWS.Organizations.ListParents();
 *
 * // runtime
 * const { Parents } = yield* listParents({ ChildId: accountId });
 * ```
 */
export interface ListParents extends Binding.Service<
  ListParents,
  "AWS.Organizations.ListParents",
  () => Effect.Effect<
    (
      request: organizations.ListParentsRequest,
    ) => Effect.Effect<
      organizations.ListParentsResponse,
      organizations.ListParentsError
    >
  >
> {}
export const ListParents = Binding.Service<ListParents>(
  "AWS.Organizations.ListParents",
);
