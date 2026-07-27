import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `ListUsers` operation (IAM action
 * `identitystore:ListUsers`), scoped to one {@link Instance}.
 *
 * Lists the users in the bound instance's identity store, one page per call (`NextToken` paginates); pass `Filters` to narrow by attribute. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.ListUsersHttp)`.
 * @binding
 * @section Looking Up Users
 * @example Enumerate Users
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const listUsers = yield* AWS.IdentityCenter.ListUsers(instance);
 *
 * // runtime
 * const { Users, NextToken } = yield* listUsers({ MaxResults: 50 });
 * console.log(Users?.map((user) => user.UserName));
 * ```
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "AWS.IdentityCenter.ListUsers",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: Omit<identitystore.ListUsersRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.ListUsersResponse,
      identitystore.ListUsersError
    >
  >
> {}
export const ListUsers = Binding.Service<ListUsers>(
  "AWS.IdentityCenter.ListUsers",
);
