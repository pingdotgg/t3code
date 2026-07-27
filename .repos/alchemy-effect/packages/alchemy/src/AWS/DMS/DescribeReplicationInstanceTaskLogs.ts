import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReplicationInstance } from "./ReplicationInstance.ts";

/**
 * Runtime binding for `dms:DescribeReplicationInstanceTaskLogs`.
 *
 * Bind this operation to a {@link ReplicationInstance} to inspect the size of
 * the task logs accumulated on the instance — useful for storage-pressure
 * monitoring and deciding when to purge logs. Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeReplicationInstanceTaskLogsHttp)`.
 * @binding
 * @section Inspecting Task Logs
 * @example Report Task Log Sizes
 * ```typescript
 * // init — bind the operation to the instance
 * const taskLogs = yield* AWS.DMS.DescribeReplicationInstanceTaskLogs(instance);
 *
 * // runtime
 * const { ReplicationInstanceTaskLogs } = yield* taskLogs();
 * ```
 */
export interface DescribeReplicationInstanceTaskLogs extends Binding.Service<
  DescribeReplicationInstanceTaskLogs,
  "AWS.DMS.DescribeReplicationInstanceTaskLogs",
  (
    instance: ReplicationInstance,
  ) => Effect.Effect<
    (
      request?: Omit<
        dms.DescribeReplicationInstanceTaskLogsMessage,
        "ReplicationInstanceArn"
      >,
    ) => Effect.Effect<
      dms.DescribeReplicationInstanceTaskLogsResponse,
      dms.DescribeReplicationInstanceTaskLogsError
    >
  >
> {}

export const DescribeReplicationInstanceTaskLogs =
  Binding.Service<DescribeReplicationInstanceTaskLogs>(
    "AWS.DMS.DescribeReplicationInstanceTaskLogs",
  );
