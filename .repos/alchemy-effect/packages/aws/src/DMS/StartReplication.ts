import type * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `dms:StartReplication`.
 *
 * Bind this operation (account-level) to start a DMS Serverless replication
 * for a replication config by ARN — DMS provisions the required capacity
 * and begins replicating. The serverless counterpart of
 * {@link StartReplicationTask}. Provide the implementation with
 * `Effect.provide(AWS.DMS.StartReplicationHttp)`.
 * ### Orchestrating Serverless Replications
 * **Example:** Start a Serverless Replication
 * ```typescript
 * // init — account-level, no target resource
 * const startReplication = yield* AWS.DMS.StartReplication();
 *
 * // runtime
 * const { Replication } = yield* startReplication({
 *   ReplicationConfigArn: configArn,
 *   StartReplicationType: "start-replication",
 * });
 * ```
 *
 * @binding
 */
export interface StartReplication extends Binding.Service<
  StartReplication,
  "AWS.DMS.StartReplication",
  () => Effect.Effect<
    (
      request: dms.StartReplicationMessage,
    ) => Effect.Effect<dms.StartReplicationResponse, dms.StartReplicationError>
  >
> {}

export const StartReplication = Binding.Service<StartReplication>("AWS.DMS.StartReplication");
