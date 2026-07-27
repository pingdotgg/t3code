import type * as TSQ from "@distilled.cloud/aws/timestream-query";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface CancelQueryRequest extends TSQ.CancelQueryRequest {}

/**
 * Runtime binding for `timestream-query:CancelQuery` — cancel a running query
 * by the `QueryId` a previous `Query` call reported.
 *
 * `timestream:CancelQuery` does not support resource-level permissions, so
 * this is an account-level binding invoked with no resource argument.
 *
 * Provide `Timestream.CancelQueryHttp` on the Function to implement the
 * binding.
 *
 * @binding
 * @section Querying Data
 * @example Cancel a running query
 * ```typescript
 * // init — account-level binding, no resource argument
 * const cancelQuery = yield* Timestream.CancelQuery();
 *
 * // runtime — cancel by the QueryId from a prior Query response
 * const result = yield* cancelQuery({ QueryId: queryId });
 * // result.CancellationMessage reports whether the query was still running
 * ```
 */
export interface CancelQuery extends Binding.Service<
  CancelQuery,
  "AWS.Timestream.CancelQuery",
  () => Effect.Effect<
    (
      request: CancelQueryRequest,
    ) => Effect.Effect<
      TSQ.CancelQueryResponse,
      TSQ.CancelQueryError | TSQ.DescribeEndpointsError
    >
  >
> {}

export const CancelQuery = Binding.Service<CancelQuery>(
  "AWS.Timestream.CancelQuery",
);
