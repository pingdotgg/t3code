import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `DeleteGroup` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface DeleteGroupRequest extends Omit<
  qbusiness.DeleteGroupRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `DeleteGroup` operation (IAM action
 * `qbusiness:DeleteGroup`), scoped to one {@link Index}.
 *
 * Deletes a mapped group so its members lose group-scoped document
 * access on the next query.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.DeleteGroupHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example Delete a Group Mapping
 * ```typescript
 * const deleteGroup = yield* AWS.QBusiness.DeleteGroup(index);
 *
 * yield* deleteGroup({ groupName: "engineering" });
 * ```
 */
export interface DeleteGroup extends Binding.Service<
  DeleteGroup,
  "AWS.QBusiness.DeleteGroup",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: DeleteGroupRequest,
    ) => Effect.Effect<
      qbusiness.DeleteGroupResponse,
      qbusiness.DeleteGroupError
    >
  >
> {}
export const DeleteGroup = Binding.Service<DeleteGroup>(
  "AWS.QBusiness.DeleteGroup",
);
