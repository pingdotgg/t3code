import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:StartReplicationTask`.
 *
 * Bind this operation (account-level) to start, resume, or reload a
 * replication task by ARN — the canonical DMS automation (a scheduled
 * Function that starts CDC during business hours, an event-driven Function
 * that kicks off a migration when upstream data lands). Provide the
 * implementation with `Effect.provide(AWS.DMS.StartReplicationTaskHttp)`.
 * @binding
 * @section Orchestrating Replication Tasks
 * @example Start a Task
 * ```typescript
 * // init — account-level, no target resource
 * const startReplicationTask = yield* AWS.DMS.StartReplicationTask();
 *
 * // runtime
 * const { ReplicationTask } = yield* startReplicationTask({
 *   ReplicationTaskArn: taskArn,
 *   StartReplicationTaskType: "start-replication",
 * });
 * ```
 */
export interface StartReplicationTask extends Binding.Service<
  StartReplicationTask,
  "AWS.DMS.StartReplicationTask",
  () => Effect.Effect<
    (
      request: dms.StartReplicationTaskMessage,
    ) => Effect.Effect<
      dms.StartReplicationTaskResponse,
      dms.StartReplicationTaskError
    >
  >
> {}

export const StartReplicationTask = Binding.Service<StartReplicationTask>(
  "AWS.DMS.StartReplicationTask",
);
