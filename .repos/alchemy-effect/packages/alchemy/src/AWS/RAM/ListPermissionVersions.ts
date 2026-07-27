import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListPermissionVersions`.
 *
 * Lists the available versions of the specified RAM permission.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListPermissionVersionsHttp)`.
 * @binding
 * @section Managed Permissions
 * @example List the Versions of a Permission
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPermissionVersions = yield* AWS.RAM.ListPermissionVersions();
 *
 * // runtime
 * const { permissions } = yield* listPermissionVersions({
 *   permissionArn: permission.permissionArn,
 * });
 * ```
 */
export interface ListPermissionVersions extends Binding.Service<
  ListPermissionVersions,
  "AWS.RAM.ListPermissionVersions",
  () => Effect.Effect<
    (
      request: ram.ListPermissionVersionsRequest,
    ) => Effect.Effect<
      ram.ListPermissionVersionsResponse,
      ram.ListPermissionVersionsError
    >
  >
> {}
export const ListPermissionVersions = Binding.Service<ListPermissionVersions>(
  "AWS.RAM.ListPermissionVersions",
);
