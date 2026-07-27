import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `CreateUser` operation (IAM action
 * `identitystore:CreateUser`), scoped to one {@link Instance}.
 *
 * Creates a user in the bound instance's identity store — e.g. a just-in-time provisioning Lambda mirroring users from an external HR system. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.CreateUserHttp)`.
 * @binding
 * @section Managing Users
 * @example Provision a User
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const createUser = yield* AWS.IdentityCenter.CreateUser(instance);
 *
 * // runtime
 * const { UserId } = yield* createUser({
 *   UserName: "jdoe",
 *   DisplayName: "Jane Doe",
 *   Name: { GivenName: "Jane", FamilyName: "Doe" },
 *   Emails: [{ Value: "jdoe@example.com", Primary: true }],
 * });
 * ```
 */
export interface CreateUser extends Binding.Service<
  CreateUser,
  "AWS.IdentityCenter.CreateUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<identitystore.CreateUserRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.CreateUserResponse,
      identitystore.CreateUserError
    >
  >
> {}
export const CreateUser = Binding.Service<CreateUser>(
  "AWS.IdentityCenter.CreateUser",
);
