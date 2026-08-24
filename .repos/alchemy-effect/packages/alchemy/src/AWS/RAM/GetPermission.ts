import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:GetPermission`.
 *
 * Retrieves the contents of a managed permission in JSON format, including its policy template.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.GetPermissionHttp)`.
 * @binding
 * @section Managed Permissions
 * @example Read a Managed Permission
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getPermission = yield* AWS.RAM.GetPermission();
 *
 * // runtime
 * const { permission } = yield* getPermission({
 *   permissionArn: customerManagedPermission.permissionArn,
 * });
 * ```
 */
export interface GetPermission extends Binding.Service<
  GetPermission,
  "AWS.RAM.GetPermission",
  () => Effect.Effect<
    (
      request: ram.GetPermissionRequest,
    ) => Effect.Effect<ram.GetPermissionResponse, ram.GetPermissionError>
  >
> {}
export const GetPermission = Binding.Service<GetPermission>(
  "AWS.RAM.GetPermission",
);
