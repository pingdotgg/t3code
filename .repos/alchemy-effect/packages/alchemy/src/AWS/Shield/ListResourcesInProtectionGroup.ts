import type * as shield from "@distilled.cloud/aws/shield";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `shield:ListResourcesInProtectionGroup`.
 *
 * Enumerates the ARNs of the protected resources that are members of a
 * protection group. The group id is passed in the request — group membership
 * is often resolved dynamically at runtime (e.g. iterating the groups from a
 * `ListProtectionGroups` sweep), and a nonexistent group fails with the typed
 * `ResourceNotFoundException`.
 * Provide the implementation with
 * `Effect.provide(AWS.Shield.ListResourcesInProtectionGroupHttp)`.
 * @binding
 * @section Grouping Protections
 * @example List a Group's Members
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listResourcesInProtectionGroup =
 *   yield* AWS.Shield.ListResourcesInProtectionGroup();
 *
 * // runtime
 * const { ResourceArns } = yield* listResourcesInProtectionGroup({
 *   ProtectionGroupId: group.protectionGroupId,
 * });
 * ```
 */
export interface ListResourcesInProtectionGroup extends Binding.Service<
  ListResourcesInProtectionGroup,
  "AWS.Shield.ListResourcesInProtectionGroup",
  () => Effect.Effect<
    (
      request: shield.ListResourcesInProtectionGroupRequest,
    ) => Effect.Effect<
      shield.ListResourcesInProtectionGroupResponse,
      shield.ListResourcesInProtectionGroupError
    >
  >
> {}
export const ListResourcesInProtectionGroup =
  Binding.Service<ListResourcesInProtectionGroup>(
    "AWS.Shield.ListResourcesInProtectionGroup",
  );
