import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `GetUserId` operation (IAM action
 * `identitystore:GetUserId`), scoped to one {@link Instance}.
 *
 * Resolves a user's `UserId` from a unique attribute (e.g. the user name) — the canonical login-to-id lookup for apps federated through Identity Center. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.GetUserIdHttp)`.
 * @binding
 * @section Looking Up Users
 * @example Resolve a UserId From a User Name
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const getUserId = yield* AWS.IdentityCenter.GetUserId(instance);
 *
 * // runtime
 * const { UserId } = yield* getUserId({
 *   AlternateIdentifier: {
 *     UniqueAttribute: {
 *       AttributePath: "userName",
 *       AttributeValue: "jdoe",
 *     },
 *   },
 * });
 * ```
 */
export interface GetUserId extends Binding.Service<
  GetUserId,
  "AWS.IdentityCenter.GetUserId",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<identitystore.GetUserIdRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.GetUserIdResponse,
      identitystore.GetUserIdError
    >
  >
> {}
export const GetUserId = Binding.Service<GetUserId>(
  "AWS.IdentityCenter.GetUserId",
);
