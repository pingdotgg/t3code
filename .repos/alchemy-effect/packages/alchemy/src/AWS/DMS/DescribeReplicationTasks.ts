import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:DescribeReplicationTasks`.
 *
 * Bind this operation (account-level) to look up replication tasks and
 * their status/progress — filter by `replication-task-id`,
 * `replication-task-arn`, `endpoint-arn`, or `replication-instance-arn`.
 * The building block of migration monitoring and start/stop automation
 * (pair with {@link StartReplicationTask} / {@link StopReplicationTask}).
 * Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeReplicationTasksHttp)`.
 * @binding
 * @section Orchestrating Replication Tasks
 * @example Check a Task's Status Before Starting It
 * ```typescript
 * // init — account-level, no target resource
 * const describeReplicationTasks = yield* AWS.DMS.DescribeReplicationTasks();
 *
 * // runtime
 * const { ReplicationTasks } = yield* describeReplicationTasks({
 *   Filters: [{ Name: "replication-task-arn", Values: [taskArn] }],
 * });
 * // ReplicationTasks[0].Status: "ready" | "running" | "stopped" | …
 * ```
 */
export interface DescribeReplicationTasks extends Binding.Service<
  DescribeReplicationTasks,
  "AWS.DMS.DescribeReplicationTasks",
  () => Effect.Effect<
    (
      request?: dms.DescribeReplicationTasksMessage,
    ) => Effect.Effect<
      dms.DescribeReplicationTasksResponse,
      dms.DescribeReplicationTasksError
    >
  >
> {}

export const DescribeReplicationTasks =
  Binding.Service<DescribeReplicationTasks>("AWS.DMS.DescribeReplicationTasks");
