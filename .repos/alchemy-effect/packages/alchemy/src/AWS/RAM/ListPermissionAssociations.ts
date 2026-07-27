import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListPermissionAssociations`.
 *
 * Lists information about managed permissions and their associations to resource shares.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListPermissionAssociationsHttp)`.
 * @binding
 * @section Managed Permissions
 * @example List Permission Associations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPermissionAssociations = yield* AWS.RAM.ListPermissionAssociations();
 *
 * // runtime
 * const { permissions } = yield* listPermissionAssociations({
 *   defaultVersion: true,
 * });
 * ```
 */
export interface ListPermissionAssociations extends Binding.Service<
  ListPermissionAssociations,
  "AWS.RAM.ListPermissionAssociations",
  () => Effect.Effect<
    (
      request?: ram.ListPermissionAssociationsRequest,
    ) => Effect.Effect<
      ram.ListPermissionAssociationsResponse,
      ram.ListPermissionAssociationsError
    >
  >
> {}
export const ListPermissionAssociations =
  Binding.Service<ListPermissionAssociations>(
    "AWS.RAM.ListPermissionAssociations",
  );
