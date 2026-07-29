import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `rds:DescribeEvents`).
 *
 * Returns events related to DocumentDB clusters, instances, snapshots, and
 * parameter groups from the last 24 hours (up to 14 days with an explicit
 * time window) — failovers, maintenance, configuration changes. Provide the
 * implementation with `Effect.provide(AWS.DocDB.DescribeEventsHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Read a Cluster's Recent Events
 * ```typescript
 * const describeEvents = yield* AWS.DocDB.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceIdentifier: clusterId,
 *   SourceType: "db-cluster",
 * });
 * for (const event of page.Events ?? []) {
 *   yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
 * }
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.DocDB.DescribeEvents",
  () => Effect.Effect<
    (
      request?: docdb.DescribeEventsMessage,
    ) => Effect.Effect<docdb.EventsMessage, docdb.DescribeEventsError>
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.DocDB.DescribeEvents",
);
