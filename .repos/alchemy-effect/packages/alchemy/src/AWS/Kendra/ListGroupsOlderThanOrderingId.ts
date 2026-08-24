import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `ListGroupsOlderThanOrderingId` request with `IndexId` injected from the bound index.
 */
export interface ListGroupsOlderThanOrderingIdRequest extends Omit<
  kendra.ListGroupsOlderThanOrderingIdRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `ListGroupsOlderThanOrderingId` operation (IAM action
 * `kendra:ListGroupsOlderThanOrderingId`), scoped to one {@link Index}.
 *
 * Lists groups whose principal mapping is older than the given ordering
 * id — used to find stale group mappings to refresh or delete.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.ListGroupsOlderThanOrderingIdHttp)`.
 *
 * @binding
 * @section Principal Mapping
 * @example List Stale Groups
 * ```typescript
 * const listGroups = yield* AWS.Kendra.ListGroupsOlderThanOrderingId(index);
 *
 * const stale = yield* listGroups({ OrderingId: orderingId });
 * console.log(stale.GroupsSummaries);
 * ```
 */
export interface ListGroupsOlderThanOrderingId extends Binding.Service<
  ListGroupsOlderThanOrderingId,
  "AWS.Kendra.ListGroupsOlderThanOrderingId",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: ListGroupsOlderThanOrderingIdRequest,
    ) => Effect.Effect<
      kendra.ListGroupsOlderThanOrderingIdResponse,
      kendra.ListGroupsOlderThanOrderingIdError
    >
  >
> {}
export const ListGroupsOlderThanOrderingId =
  Binding.Service<ListGroupsOlderThanOrderingId>(
    "AWS.Kendra.ListGroupsOlderThanOrderingId",
  );
