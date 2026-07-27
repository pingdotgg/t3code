import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListChildren`.
 *
 * Lists the child accounts or organizational units directly under the specified parent root or OU — one level of the organization tree at a time.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListChildrenHttp)`.
 * @binding
 * @section Reading the Organization Tree
 * @example Walk One Tree Level
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listChildren = yield* AWS.Organizations.ListChildren();
 *
 * // runtime
 * const { Children } = yield* listChildren({
 *   ParentId: rootId,
 *   ChildType: "ORGANIZATIONAL_UNIT",
 * });
 * ```
 */
export interface ListChildren extends Binding.Service<
  ListChildren,
  "AWS.Organizations.ListChildren",
  () => Effect.Effect<
    (
      request: organizations.ListChildrenRequest,
    ) => Effect.Effect<
      organizations.ListChildrenResponse,
      organizations.ListChildrenError
    >
  >
> {}
export const ListChildren = Binding.Service<ListChildren>(
  "AWS.Organizations.ListChildren",
);
