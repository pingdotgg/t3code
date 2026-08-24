import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListPermissions`.
 *
 * Lists the AWS managed and customer managed RAM permissions available for the supported resource types.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListPermissionsHttp)`.
 * @binding
 * @section Managed Permissions
 * @example List the Customer Managed Permissions
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPermissions = yield* AWS.RAM.ListPermissions();
 *
 * // runtime
 * const { permissions } = yield* listPermissions({
 *   permissionType: "CUSTOMER_MANAGED",
 * });
 * ```
 */
export interface ListPermissions extends Binding.Service<
  ListPermissions,
  "AWS.RAM.ListPermissions",
  () => Effect.Effect<
    (
      request?: ram.ListPermissionsRequest,
    ) => Effect.Effect<ram.ListPermissionsResponse, ram.ListPermissionsError>
  >
> {}
export const ListPermissions = Binding.Service<ListPermissions>(
  "AWS.RAM.ListPermissions",
);
