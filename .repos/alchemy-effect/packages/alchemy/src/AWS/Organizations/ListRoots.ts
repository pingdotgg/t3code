import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListRoots`.
 *
 * Lists the roots of the organization, including the policy types enabled on each root. The root id is the starting point for walking the organization tree.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListRootsHttp)`.
 * @binding
 * @section Reading the Organization Tree
 * @example Find the Root Id
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listRoots = yield* AWS.Organizations.ListRoots();
 *
 * // runtime
 * const { Roots } = yield* listRoots();
 * const rootId = Roots?.[0]?.Id;
 * ```
 */
export interface ListRoots extends Binding.Service<
  ListRoots,
  "AWS.Organizations.ListRoots",
  () => Effect.Effect<
    (
      request?: organizations.ListRootsRequest,
    ) => Effect.Effect<
      organizations.ListRootsResponse,
      organizations.ListRootsError
    >
  >
> {}
export const ListRoots = Binding.Service<ListRoots>(
  "AWS.Organizations.ListRoots",
);
