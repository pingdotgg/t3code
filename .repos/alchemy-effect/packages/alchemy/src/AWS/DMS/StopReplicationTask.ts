import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:StopReplicationTask`.
 *
 * Bind this operation (account-level) to stop a running replication task by
 * ARN — the other half of scheduled CDC windows and cost-control automation
 * (pair with {@link StartReplicationTask}). Provide the implementation with
 * `Effect.provide(AWS.DMS.StopReplicationTaskHttp)`.
 * @binding
 * @section Orchestrating Replication Tasks
 * @example Stop a Running Task
 * ```typescript
 * // init — account-level, no target resource
 * const stopReplicationTask = yield* AWS.DMS.StopReplicationTask();
 *
 * // runtime
 * const { ReplicationTask } = yield* stopReplicationTask({
 *   ReplicationTaskArn: taskArn,
 * });
 * ```
 */
export interface StopReplicationTask extends Binding.Service<
  StopReplicationTask,
  "AWS.DMS.StopReplicationTask",
  () => Effect.Effect<
    (
      request: dms.StopReplicationTaskMessage,
    ) => Effect.Effect<
      dms.StopReplicationTaskResponse,
      dms.StopReplicationTaskError
    >
  >
> {}

export const StopReplicationTask = Binding.Service<StopReplicationTask>(
  "AWS.DMS.StopReplicationTask",
);
