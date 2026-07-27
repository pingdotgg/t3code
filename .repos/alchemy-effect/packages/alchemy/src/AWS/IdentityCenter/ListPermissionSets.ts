import type * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListPermissionSets` operation (IAM action
 * `sso:ListPermissionSets`), scoped to one {@link Instance}.
 *
 * Lists the permission set ARNs in the bound Identity Center instance, one page per call (`NextToken` paginates). The instance's
 * `InstanceArn` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListPermissionSetsHttp)`.
 * @binding
 * @section Reading Permission Sets
 * @example Enumerate Permission Sets
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listPermissionSets = yield* AWS.IdentityCenter.ListPermissionSets(instance);
 *
 * // runtime
 * const { PermissionSets } = yield* listPermissionSets({ MaxResults: 100 });
 * ```
 */
export interface ListPermissionSets extends Binding.Service<
  ListPermissionSets,
  "AWS.IdentityCenter.ListPermissionSets",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: Omit<ssoAdmin.ListPermissionSetsRequest, "InstanceArn">,
    ) => Effect.Effect<
      ssoAdmin.ListPermissionSetsResponse,
      ssoAdmin.ListPermissionSetsError
    >
  >
> {}
export const ListPermissionSets = Binding.Service<ListPermissionSets>(
  "AWS.IdentityCenter.ListPermissionSets",
);
