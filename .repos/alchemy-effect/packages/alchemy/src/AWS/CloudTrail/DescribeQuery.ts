import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Runtime binding for `cloudtrail:DescribeQuery`.
 *
 * Reads a CloudTrail Lake query's status, statistics, and error message by
 * `QueryId` — the polling half of the start/poll/results flow. Provide the
 * implementation with `Effect.provide(AWS.CloudTrail.DescribeQueryHttp)`.
 * @binding
 * @section Querying CloudTrail Lake
 * @example Poll a Query to Completion
 * ```typescript
 * // init — bind the operation to the event data store
 * const describeQuery = yield* AWS.CloudTrail.DescribeQuery(store);
 *
 * // runtime
 * const status = yield* describeQuery({ QueryId: queryId });
 * console.log(status.QueryStatus); // QUEUED | RUNNING | FINISHED | ...
 * ```
 */
export interface DescribeQuery extends Binding.Service<
  DescribeQuery,
  "AWS.CloudTrail.DescribeQuery",
  (
    store: EventDataStore,
  ) => Effect.Effect<
    (
      request: Omit<cloudtrail.DescribeQueryRequest, "EventDataStore">,
    ) => Effect.Effect<
      cloudtrail.DescribeQueryResponse,
      cloudtrail.DescribeQueryError
    >
  >
> {}
export const DescribeQuery = Binding.Service<DescribeQuery>(
  "AWS.CloudTrail.DescribeQuery",
);
