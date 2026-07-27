import type * as TSQ from "@distilled.cloud/aws/timestream-query";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ScheduledQuery } from "./ScheduledQuery.ts";

export interface ExecuteScheduledQueryRequest extends Omit<
  TSQ.ExecuteScheduledQueryRequest,
  "ScheduledQueryArn"
> {}

/**
 * Runtime binding for `timestream-query:ExecuteScheduledQuery` — manually
 * run a {@link ScheduledQuery} for a given invocation time (e.g. to backfill
 * a window the schedule missed).
 *
 * Bind the operation to the scheduled query to get a callable with
 * `ScheduledQueryArn` injected automatically.
 *
 * Provide `Timestream.ExecuteScheduledQueryHttp` on the Function to
 * implement the binding.
 *
 * @binding
 * @section Creating Scheduled Queries
 * @example Backfill a missed window
 * ```typescript
 * // init — bind the operation to the scheduled query
 * const executeScheduledQuery = yield* Timestream.ExecuteScheduledQuery(rollup);
 *
 * // runtime — re-run the rollup as-of one hour ago
 * yield* executeScheduledQuery({
 *   InvocationTime: new Date(Date.now() - 60 * 60 * 1000),
 * });
 * ```
 */
export interface ExecuteScheduledQuery extends Binding.Service<
  ExecuteScheduledQuery,
  "AWS.Timestream.ExecuteScheduledQuery",
  (
    scheduledQuery: ScheduledQuery,
  ) => Effect.Effect<
    (
      request: ExecuteScheduledQueryRequest,
    ) => Effect.Effect<
      TSQ.ExecuteScheduledQueryResponse,
      TSQ.ExecuteScheduledQueryError | TSQ.DescribeEndpointsError
    >
  >
> {}

export const ExecuteScheduledQuery = Binding.Service<ExecuteScheduledQuery>(
  "AWS.Timestream.ExecuteScheduledQuery",
);
