import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `rds:DescribeEvents`).
 *
 * Lists recent events (failovers, maintenance, snapshots, parameter changes)
 * for the account's Neptune clusters and instances — the audit trail for
 * operational tooling. Provide the implementation with
 * `Effect.provide(AWS.Neptune.DescribeEventsHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example List a Cluster's Recent Events
 * ```typescript
 * const describeEvents = yield* AWS.Neptune.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceIdentifier: clusterId,
 *   SourceType: "db-cluster",
 * });
 * const messages = page.Events?.map((e) => e.Message);
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.Neptune.DescribeEvents",
  () => Effect.Effect<
    (
      request?: neptune.DescribeEventsMessage,
    ) => Effect.Effect<neptune.EventsMessage, neptune.DescribeEventsError>
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.Neptune.DescribeEvents",
);
