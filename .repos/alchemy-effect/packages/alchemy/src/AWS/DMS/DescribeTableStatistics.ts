import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:DescribeTableStatistics`.
 *
 * Bind this operation (account-level) to read per-table migration progress
 * for a replication task — rows inserted/updated/deleted, full-load
 * completion, validation state. The data behind migration progress
 * dashboards and cut-over gates. Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeTableStatisticsHttp)`.
 * @binding
 * @section Monitoring Migration Progress
 * @example Gate a Cut-Over on Full-Load Completion
 * ```typescript
 * // init — account-level, no target resource
 * const describeTableStatistics = yield* AWS.DMS.DescribeTableStatistics();
 *
 * // runtime
 * const { TableStatistics } = yield* describeTableStatistics({
 *   ReplicationTaskArn: taskArn,
 * });
 * const pending = TableStatistics?.filter(
 *   (table) => table.FullLoadEndTime === undefined,
 * );
 * ```
 */
export interface DescribeTableStatistics extends Binding.Service<
  DescribeTableStatistics,
  "AWS.DMS.DescribeTableStatistics",
  () => Effect.Effect<
    (
      request: dms.DescribeTableStatisticsMessage,
    ) => Effect.Effect<
      dms.DescribeTableStatisticsResponse,
      dms.DescribeTableStatisticsError
    >
  >
> {}

export const DescribeTableStatistics = Binding.Service<DescribeTableStatistics>(
  "AWS.DMS.DescribeTableStatistics",
);
