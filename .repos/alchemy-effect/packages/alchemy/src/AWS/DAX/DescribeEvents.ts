import type * as dax from "@distilled.cloud/aws/dax";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `dax:DescribeEvents`).
 *
 * Returns events related to DAX clusters and parameter groups from the last
 * 24 hours (up to 14 days with an explicit time window) — node reboots,
 * failovers, configuration changes. Provide the implementation with
 * `Effect.provide(AWS.DAX.DescribeEventsHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Read a Cluster's Recent Events
 * ```typescript
 * const describeEvents = yield* DAX.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceName: clusterName,
 *   SourceType: "CLUSTER",
 * });
 * for (const event of page.Events ?? []) {
 *   yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
 * }
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.DAX.DescribeEvents",
  () => Effect.Effect<
    (
      request?: dax.DescribeEventsRequest,
    ) => Effect.Effect<dax.DescribeEventsResponse, dax.DescribeEventsError>
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.DAX.DescribeEvents",
);
