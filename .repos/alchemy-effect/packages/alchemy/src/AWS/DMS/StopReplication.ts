import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:StopReplication`.
 *
 * Bind this operation (account-level) to stop a running DMS Serverless
 * replication by replication-config ARN (the stopped replication keeps its
 * provisioned capacity). The serverless counterpart of
 * {@link StopReplicationTask}. Provide the implementation with
 * `Effect.provide(AWS.DMS.StopReplicationHttp)`.
 * @binding
 * @section Orchestrating Serverless Replications
 * @example Stop a Serverless Replication
 * ```typescript
 * // init — account-level, no target resource
 * const stopReplication = yield* AWS.DMS.StopReplication();
 *
 * // runtime
 * const { Replication } = yield* stopReplication({
 *   ReplicationConfigArn: configArn,
 * });
 * ```
 */
export interface StopReplication extends Binding.Service<
  StopReplication,
  "AWS.DMS.StopReplication",
  () => Effect.Effect<
    (
      request: dms.StopReplicationMessage,
    ) => Effect.Effect<dms.StopReplicationResponse, dms.StopReplicationError>
  >
> {}

export const StopReplication = Binding.Service<StopReplication>(
  "AWS.DMS.StopReplication",
);
