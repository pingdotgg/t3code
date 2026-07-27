import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `rds:DescribeEvents`).
 *
 * Lists recent RDS events (instance/cluster/snapshot/parameter-group
 * lifecycle notifications from the last 14 days) — the pull-based
 * counterpart to {@link consumeRdsEvents}. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeEventsHttp)`.
 * @binding
 * @section Monitoring Databases
 * @example List Recent Events for a Cluster
 * ```typescript
 * const describeEvents = yield* AWS.RDS.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceType: "db-cluster",
 *   SourceIdentifier: clusterId,
 * });
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.RDS.DescribeEvents",
  () => Effect.Effect<
    (
      request?: rds.DescribeEventsMessage,
    ) => Effect.Effect<rds.EventsMessage, rds.DescribeEventsError>
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.RDS.DescribeEvents",
);
