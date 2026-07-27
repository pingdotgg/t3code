import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `UpdateUser` operation (IAM action
 * `identitystore:UpdateUser`), scoped to one {@link Instance}.
 *
 * Applies attribute patch operations to a user in the bound instance's identity store (display name, emails, addresses, ...). The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.UpdateUserHttp)`.
 * @binding
 * @section Managing Users
 * @example Update a User's Display Name
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const updateUser = yield* AWS.IdentityCenter.UpdateUser(instance);
 *
 * // runtime
 * yield* updateUser({
 *   UserId: userId,
 *   Operations: [
 *     { AttributePath: "displayName", AttributeValue: "Jane A. Doe" },
 *   ],
 * });
 * ```
 */
export interface UpdateUser extends Binding.Service<
  UpdateUser,
  "AWS.IdentityCenter.UpdateUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<identitystore.UpdateUserRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.UpdateUserResponse,
      identitystore.UpdateUserError
    >
  >
> {}
export const UpdateUser = Binding.Service<UpdateUser>(
  "AWS.IdentityCenter.UpdateUser",
);
