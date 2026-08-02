import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `memorydb:DescribeEvents`).
 *
 * Returns events related to clusters, security groups, and parameter groups
 * from the last hour (up to 14 days with an explicit time window) — snapshot
 * completions, failovers, configuration changes. Provide the implementation
 * with `Effect.provide(AWS.MemoryDB.DescribeEventsHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Read a Cluster's Recent Events
 * ```typescript
 * const describeEvents = yield* MemoryDB.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceName: clusterName,
 *   SourceType: "cluster",
 * });
 * for (const event of page.Events ?? []) {
 *   yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
 * }
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.MemoryDB.DescribeEvents",
  () => Effect.Effect<
    (
      request?: memorydb.DescribeEventsRequest,
    ) => Effect.Effect<
      memorydb.DescribeEventsResponse,
      memorydb.DescribeEventsError
    >
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.MemoryDB.DescribeEvents",
);
