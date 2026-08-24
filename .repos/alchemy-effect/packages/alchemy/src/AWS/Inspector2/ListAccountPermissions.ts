import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ListAccountPermissions`.
 *
 * Lists the permissions an account has to configure Amazon Inspector.
 * If the account is a member account or standalone account with resources managed by an Organizations policy, the operation returns fewer permissions.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListAccountPermissionsHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example List Granted Permissions
 * ```typescript
 * // init
 * const listAccountPermissions = yield* AWS.Inspector2.ListAccountPermissions();
 *
 * // runtime
 * const { permissions } = yield* listAccountPermissions();
 * ```
 */
export interface ListAccountPermissions extends Binding.Service<
  ListAccountPermissions,
  "AWS.Inspector2.ListAccountPermissions",
  () => Effect.Effect<
    (
      request?: inspector2.ListAccountPermissionsRequest,
    ) => Effect.Effect<
      inspector2.ListAccountPermissionsResponse,
      inspector2.ListAccountPermissionsError
    >
  >
> {}
export const ListAccountPermissions = Binding.Service<ListAccountPermissions>(
  "AWS.Inspector2.ListAccountPermissions",
);
