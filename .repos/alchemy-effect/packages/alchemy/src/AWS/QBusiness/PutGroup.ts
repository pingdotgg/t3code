import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `PutGroup` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface PutGroupRequest extends Omit<
  qbusiness.PutGroupRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `PutGroup` operation (IAM action
 * `qbusiness:PutGroup`), scoped to one {@link Index}.
 *
 * Creates or replaces a group's membership (users and sub groups)
 * used to enforce document access control at query time.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.PutGroupHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example Map a Group's Members
 * ```typescript
 * const putGroup = yield* AWS.QBusiness.PutGroup(index);
 *
 * yield* putGroup({
 *   groupName: "engineering",
 *   type: "INDEX",
 *   groupMembers: {
 *     memberUsers: [{ userId: "user@example.com", type: "INDEX" }],
 *   },
 * });
 * ```
 */
export interface PutGroup extends Binding.Service<
  PutGroup,
  "AWS.QBusiness.PutGroup",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: PutGroupRequest,
    ) => Effect.Effect<qbusiness.PutGroupResponse, qbusiness.PutGroupError>
  >
> {}
export const PutGroup = Binding.Service<PutGroup>("AWS.QBusiness.PutGroup");
