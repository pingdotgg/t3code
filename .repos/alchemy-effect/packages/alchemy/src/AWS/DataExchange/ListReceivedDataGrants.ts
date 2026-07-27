import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:ListReceivedDataGrants`.
 *
 * Enumerates the data grants this account has received, optionally
 * filtered by acceptance state (`PENDING_RECEIVER_ACCEPTANCE`,
 * `ACCEPTED`).
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListReceivedDataGrantsHttp)`.
 * @binding
 * @section Data Grants
 * @example Find Pending Grants
 * ```typescript
 * const listReceivedDataGrants =
 *   yield* AWS.DataExchange.ListReceivedDataGrants();
 *
 * // runtime
 * const { DataGrantSummaries } = yield* listReceivedDataGrants({
 *   AcceptanceState: ["PENDING_RECEIVER_ACCEPTANCE"],
 * });
 * ```
 */
export interface ListReceivedDataGrants extends Binding.Service<
  ListReceivedDataGrants,
  "AWS.DataExchange.ListReceivedDataGrants",
  () => Effect.Effect<
    (
      request?: dataexchange.ListReceivedDataGrantsRequest,
    ) => Effect.Effect<
      dataexchange.ListReceivedDataGrantsResponse,
      dataexchange.ListReceivedDataGrantsError
    >
  >
> {}
export const ListReceivedDataGrants = Binding.Service<ListReceivedDataGrants>(
  "AWS.DataExchange.ListReceivedDataGrants",
);
