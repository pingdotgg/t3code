import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `GetGroup` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface GetGroupRequest extends Omit<
  qbusiness.GetGroupRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `GetGroup` operation (IAM action
 * `qbusiness:GetGroup`), scoped to one {@link Index}.
 *
 * Reads a mapped group's processing status.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.GetGroupHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example Read a Group's Status
 * ```typescript
 * const getGroup = yield* AWS.QBusiness.GetGroup(index);
 *
 * const { status } = yield* getGroup({ groupName: "engineering" });
 * ```
 */
export interface GetGroup extends Binding.Service<
  GetGroup,
  "AWS.QBusiness.GetGroup",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: GetGroupRequest,
    ) => Effect.Effect<qbusiness.GetGroupResponse, qbusiness.GetGroupError>
  >
> {}
export const GetGroup = Binding.Service<GetGroup>("AWS.QBusiness.GetGroup");
