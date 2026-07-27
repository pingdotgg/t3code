import type * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListAccountsForProvisionedPermissionSet` operation (IAM action
 * `sso:ListAccountsForProvisionedPermissionSet`), scoped to one {@link Instance}.
 *
 * Lists the AWS accounts where a permission set is provisioned, one page per call (`NextToken` paginates). The instance's
 * `InstanceArn` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListAccountsForProvisionedPermissionSetHttp)`.
 * @binding
 * @section Auditing Access
 * @example List a Permission Set's Accounts
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listAccountsForProvisionedPermissionSet = yield* AWS.IdentityCenter.ListAccountsForProvisionedPermissionSet(instance);
 *
 * // runtime
 * const { AccountIds } = yield* listAccountsForProvisionedPermissionSet({
 *   PermissionSetArn: permissionSetArn,
 * });
 * ```
 */
export interface ListAccountsForProvisionedPermissionSet extends Binding.Service<
  ListAccountsForProvisionedPermissionSet,
  "AWS.IdentityCenter.ListAccountsForProvisionedPermissionSet",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        ssoAdmin.ListAccountsForProvisionedPermissionSetRequest,
        "InstanceArn"
      >,
    ) => Effect.Effect<
      ssoAdmin.ListAccountsForProvisionedPermissionSetResponse,
      ssoAdmin.ListAccountsForProvisionedPermissionSetError
    >
  >
> {}
export const ListAccountsForProvisionedPermissionSet =
  Binding.Service<ListAccountsForProvisionedPermissionSet>(
    "AWS.IdentityCenter.ListAccountsForProvisionedPermissionSet",
  );
