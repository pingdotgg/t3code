import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `DescribeUser` operation (IAM action
 * `identitystore:DescribeUser`), scoped to one {@link Instance}.
 *
 * Reads a user's metadata and attributes (user name, display name, emails) from the bound instance's identity store by `UserId`. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.DescribeUserHttp)`.
 * @binding
 * @section Looking Up Users
 * @example Read a User's Profile
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const describeUser = yield* AWS.IdentityCenter.DescribeUser(instance);
 *
 * // runtime
 * const user = yield* describeUser({ UserId: userId });
 * console.log(user.UserName, user.DisplayName);
 * ```
 */
export interface DescribeUser extends Binding.Service<
  DescribeUser,
  "AWS.IdentityCenter.DescribeUser",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<identitystore.DescribeUserRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.DescribeUserResponse,
      identitystore.DescribeUserError
    >
  >
> {}
export const DescribeUser = Binding.Service<DescribeUser>(
  "AWS.IdentityCenter.DescribeUser",
);
