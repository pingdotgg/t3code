import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:DescribeEvents`.
 *
 * Bind this operation (account-level) to read recent DMS events — instance
 * reboots, failovers, configuration changes — for monitoring and audit
 * workloads. Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeEventsHttp)`.
 * @binding
 * @section Reading DMS Events
 * @example Read the Last Hour of Instance Events
 * ```typescript
 * // init — account-level, no target resource
 * const describeEvents = yield* AWS.DMS.DescribeEvents();
 *
 * // runtime
 * const { Events } = yield* describeEvents({
 *   SourceType: "replication-instance",
 *   Duration: 60, // minutes
 * });
 * ```
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.DMS.DescribeEvents",
  () => Effect.Effect<
    (
      request?: dms.DescribeEventsMessage,
    ) => Effect.Effect<dms.DescribeEventsResponse, dms.DescribeEventsError>
  >
> {}

export const DescribeEvents = Binding.Service<DescribeEvents>(
  "AWS.DMS.DescribeEvents",
);
