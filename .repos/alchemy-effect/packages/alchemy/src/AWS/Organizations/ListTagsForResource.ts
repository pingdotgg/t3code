import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListTagsForResource`.
 *
 * Lists the tags attached to the specified Organizations resource — an account, root, organizational unit, or policy.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListTagsForResourceHttp)`.
 * @binding
 * @section Tags
 * @example Read an Account's Organization Tags
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listTagsForResource = yield* AWS.Organizations.ListTagsForResource();
 *
 * // runtime
 * const { Tags } = yield* listTagsForResource({ ResourceId: accountId });
 * ```
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.Organizations.ListTagsForResource",
  () => Effect.Effect<
    (
      request: organizations.ListTagsForResourceRequest,
    ) => Effect.Effect<
      organizations.ListTagsForResourceResponse,
      organizations.ListTagsForResourceError
    >
  >
> {}
export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.Organizations.ListTagsForResource",
);
