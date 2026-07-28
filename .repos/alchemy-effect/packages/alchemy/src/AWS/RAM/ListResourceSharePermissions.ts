import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListResourceSharePermissions`.
 *
 * Lists the RAM permissions that are associated with a resource share.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListResourceSharePermissionsHttp)`.
 * @binding
 * @section Managed Permissions
 * @example List the Permissions on a Share
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listResourceSharePermissions = yield* AWS.RAM.ListResourceSharePermissions();
 *
 * // runtime
 * const { permissions } = yield* listResourceSharePermissions({
 *   resourceShareArn: share.resourceShareArn,
 * });
 * ```
 */
export interface ListResourceSharePermissions extends Binding.Service<
  ListResourceSharePermissions,
  "AWS.RAM.ListResourceSharePermissions",
  () => Effect.Effect<
    (
      request: ram.ListResourceSharePermissionsRequest,
    ) => Effect.Effect<
      ram.ListResourceSharePermissionsResponse,
      ram.ListResourceSharePermissionsError
    >
  >
> {}
export const ListResourceSharePermissions =
  Binding.Service<ListResourceSharePermissions>(
    "AWS.RAM.ListResourceSharePermissions",
  );
