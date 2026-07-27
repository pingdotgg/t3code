import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListProtocolsLists}.
 */
export interface ListProtocolsListsRequest
  extends fms.ListProtocolsListsRequest {}

/**
 * Runtime binding for `fms:ListProtocolsLists`.
 *
 * Returns an array of `ProtocolsListDataSummary` objects for the protocols lists in the administrator's account. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListProtocolsListsHttp)`.
 * @binding
 * @section Protocols Lists
 * @example List Protocols Lists
 * ```typescript
 * // init — account-level binding takes no resource
 * const listProtocolsLists = yield* AWS.FMS.ListProtocolsLists();
 *
 * // runtime
 * const result = yield* listProtocolsLists({ MaxResults: 25 });
 * console.log(result.ProtocolsLists?.length);
 * ```
 */
export interface ListProtocolsLists extends Binding.Service<
  ListProtocolsLists,
  "AWS.FMS.ListProtocolsLists",
  () => Effect.Effect<
    (
      request: ListProtocolsListsRequest,
    ) => Effect.Effect<
      fms.ListProtocolsListsResponse,
      fms.ListProtocolsListsError
    >
  >
> {}

export const ListProtocolsLists = Binding.Service<ListProtocolsLists>(
  "AWS.FMS.ListProtocolsLists",
);
