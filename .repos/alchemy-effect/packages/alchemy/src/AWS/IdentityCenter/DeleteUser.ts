import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `DeleteUser` operation (IAM action
 * `identitystore:DeleteUser`), scoped to one {@link Instance}.
 *
 * Deletes a user from the bound instance's identity store — the deprovisioning half of a user-sync Lambda. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.DeleteUserHttp)`.
 * @binding
 * @section Managing Users
 * @example Deprovision a User
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const deleteUser = yield* AWS.IdentityCenter.DeleteUser(instance);
 *
 * // runtime
 * yield* deleteUser({ UserId: userId });
 * ```
 */
export interface DeleteUser extends Binding.Service<
  DeleteUser,
  "AWS.IdentityCenter.DeleteUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<identitystore.DeleteUserRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.DeleteUserResponse,
      identitystore.DeleteUserError
    >
  >
> {}
export const DeleteUser = Binding.Service<DeleteUser>(
  "AWS.IdentityCenter.DeleteUser",
);
