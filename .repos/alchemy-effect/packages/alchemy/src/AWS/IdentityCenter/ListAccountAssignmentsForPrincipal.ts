import type * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListAccountAssignmentsForPrincipal` operation (IAM action
 * `sso:ListAccountAssignmentsForPrincipal`), scoped to one {@link Instance}.
 *
 * Lists every account assignment a user or group holds across the organization — "what can this principal access?" for access portals. Only valid on organization instances, called from the management account. The instance's
 * `InstanceArn` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListAccountAssignmentsForPrincipalHttp)`.
 * @binding
 * @section Auditing Access
 * @example List a Principal's Assignments
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listAccountAssignmentsForPrincipal = yield* AWS.IdentityCenter.ListAccountAssignmentsForPrincipal(instance);
 *
 * // runtime
 * const { AccountAssignments } = yield* listAccountAssignmentsForPrincipal({
 *   PrincipalId: groupId,
 *   PrincipalType: "GROUP",
 * });
 * ```
 */
export interface ListAccountAssignmentsForPrincipal extends Binding.Service<
  ListAccountAssignmentsForPrincipal,
  "AWS.IdentityCenter.ListAccountAssignmentsForPrincipal",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<
        ssoAdmin.ListAccountAssignmentsForPrincipalRequest,
        "InstanceArn"
      >,
    ) => Effect.Effect<
      ssoAdmin.ListAccountAssignmentsForPrincipalResponse,
      ssoAdmin.ListAccountAssignmentsForPrincipalError
    >
  >
> {}
export const ListAccountAssignmentsForPrincipal =
  Binding.Service<ListAccountAssignmentsForPrincipal>(
    "AWS.IdentityCenter.ListAccountAssignmentsForPrincipal",
  );
