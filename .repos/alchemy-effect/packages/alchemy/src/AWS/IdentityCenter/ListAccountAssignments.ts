import type * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListAccountAssignments` operation (IAM action
 * `sso:ListAccountAssignments`), scoped to one {@link Instance}.
 *
 * Lists who (users/groups) holds a permission set in an AWS account — the core query of an access-review Lambda. The instance's
 * `InstanceArn` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListAccountAssignmentsHttp)`.
 * @binding
 * @section Auditing Access
 * @example List a Permission Set's Assignees
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listAccountAssignments = yield* AWS.IdentityCenter.ListAccountAssignments(instance);
 *
 * // runtime
 * const { AccountAssignments } = yield* listAccountAssignments({
 *   AccountId: accountId,
 *   PermissionSetArn: permissionSetArn,
 * });
 * ```
 */
export interface ListAccountAssignments extends Binding.Service<
  ListAccountAssignments,
  "AWS.IdentityCenter.ListAccountAssignments",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<ssoAdmin.ListAccountAssignmentsRequest, "InstanceArn">,
    ) => Effect.Effect<
      ssoAdmin.ListAccountAssignmentsResponse,
      ssoAdmin.ListAccountAssignmentsError
    >
  >
> {}
export const ListAccountAssignments = Binding.Service<ListAccountAssignments>(
  "AWS.IdentityCenter.ListAccountAssignments",
);
