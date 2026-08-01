import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:ListDataGrants`.
 *
 * Enumerates the data grants this account has sent.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListDataGrantsHttp)`.
 * @binding
 * @section Data Grants
 * @example List Sent Grants
 * ```typescript
 * const listDataGrants = yield* AWS.DataExchange.ListDataGrants();
 *
 * // runtime
 * const { DataGrantSummaries } = yield* listDataGrants();
 * ```
 */
export interface ListDataGrants extends Binding.Service<
  ListDataGrants,
  "AWS.DataExchange.ListDataGrants",
  () => Effect.Effect<
    (
      request?: dataexchange.ListDataGrantsRequest,
    ) => Effect.Effect<
      dataexchange.ListDataGrantsResponse,
      dataexchange.ListDataGrantsError
    >
  >
> {}
export const ListDataGrants = Binding.Service<ListDataGrants>(
  "AWS.DataExchange.ListDataGrants",
);
