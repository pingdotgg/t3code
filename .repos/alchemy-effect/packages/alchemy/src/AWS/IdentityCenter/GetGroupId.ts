import type * as identitystore from "@distilled.cloud/aws/identitystore";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for the `GetGroupId` operation (IAM action
 * `identitystore:GetGroupId`), scoped to one {@link Instance}.
 *
 * Resolves a group's `GroupId` from a unique attribute (e.g. the display name) in the bound instance's identity store. The instance's
 * `IdentityStoreId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.IdentityCenter.GetGroupIdHttp)`.
 * @binding
 * @section Looking Up Groups
 * @example Resolve a GroupId From a Display Name
 * ```typescript
 * // init — bind the operation to the Identity Center instance
 * const getGroupId = yield* AWS.IdentityCenter.GetGroupId(instance);
 *
 * // runtime
 * const { GroupId } = yield* getGroupId({
 *   AlternateIdentifier: {
 *     UniqueAttribute: {
 *       AttributePath: "displayName",
 *       AttributeValue: "platform-engineers",
 *     },
 *   },
 * });
 * ```
 */
export interface GetGroupId extends Binding.Service<
  GetGroupId,
  "AWS.IdentityCenter.GetGroupId",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: Omit<identitystore.GetGroupIdRequest, "IdentityStoreId">,
    ) => Effect.Effect<
      identitystore.GetGroupIdResponse,
      identitystore.GetGroupIdError
    >
  >
> {}
export const GetGroupId = Binding.Service<GetGroupId>(
  "AWS.IdentityCenter.GetGroupId",
);
