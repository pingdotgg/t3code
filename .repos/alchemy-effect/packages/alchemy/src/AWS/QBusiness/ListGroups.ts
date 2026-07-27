import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `ListGroups` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface ListGroupsRequest extends Omit<
  qbusiness.ListGroupsRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `ListGroups` operation (IAM action
 * `qbusiness:ListGroups`), scoped to one {@link Index}.
 *
 * Lists the groups mapped into the index before a given time.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListGroupsHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example List Mapped Groups
 * ```typescript
 * const listGroups = yield* AWS.QBusiness.ListGroups(index);
 *
 * const { items } = yield* listGroups({ updatedEarlierThan: new Date() });
 * ```
 */
export interface ListGroups extends Binding.Service<
  ListGroups,
  "AWS.QBusiness.ListGroups",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: ListGroupsRequest,
    ) => Effect.Effect<qbusiness.ListGroupsResponse, qbusiness.ListGroupsError>
  >
> {}
export const ListGroups = Binding.Service<ListGroups>(
  "AWS.QBusiness.ListGroups",
);
