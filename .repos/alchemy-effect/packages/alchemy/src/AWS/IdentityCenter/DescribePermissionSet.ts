import type * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `DescribePermissionSet` operation (IAM action
 * `sso:DescribePermissionSet`), scoped to one {@link Instance}.
 *
 * Reads a permission set's details (name, description, session duration, relay state) from the bound Identity Center instance. The instance's
 * `InstanceArn` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.DescribePermissionSetHttp)`.
 * @binding
 * @section Reading Permission Sets
 * @example Read a Permission Set
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const describePermissionSet = yield* AWS.IdentityCenter.DescribePermissionSet(instance);
 *
 * // runtime
 * const { PermissionSet } = yield* describePermissionSet({
 *   PermissionSetArn: permissionSetArn,
 * });
 * console.log(PermissionSet?.Name, PermissionSet?.SessionDuration);
 * ```
 */
export interface DescribePermissionSet extends Binding.Service<
  DescribePermissionSet,
  "AWS.IdentityCenter.DescribePermissionSet",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<ssoAdmin.DescribePermissionSetRequest, "InstanceArn">,
    ) => Effect.Effect<
      ssoAdmin.DescribePermissionSetResponse,
      ssoAdmin.DescribePermissionSetError
    >
  >
> {}
export const DescribePermissionSet = Binding.Service<DescribePermissionSet>(
  "AWS.IdentityCenter.DescribePermissionSet",
);
