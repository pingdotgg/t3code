import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReplicationInstance } from "./ReplicationInstance.ts";

/**
 * Runtime binding for `dms:RebootReplicationInstance`.
 *
 * Bind this operation to a {@link ReplicationInstance} to reboot it (e.g. to
 * recover a stuck migration or force a Multi-AZ failover with
 * `ForceFailover`). Provide the implementation with
 * `Effect.provide(AWS.DMS.RebootReplicationInstanceHttp)`.
 * @binding
 * @section Rebooting an Instance
 * @example Reboot with Planned Failover
 * ```typescript
 * // init — bind the operation to the instance
 * const reboot = yield* AWS.DMS.RebootReplicationInstance(instance);
 *
 * // runtime
 * yield* reboot({ ForcePlannedFailover: true });
 * ```
 */
export interface RebootReplicationInstance extends Binding.Service<
  RebootReplicationInstance,
  "AWS.DMS.RebootReplicationInstance",
  (
    instance: ReplicationInstance,
  ) => Effect.Effect<
    (
      request?: Omit<
        dms.RebootReplicationInstanceMessage,
        "ReplicationInstanceArn"
      >,
    ) => Effect.Effect<
      dms.RebootReplicationInstanceResponse,
      dms.RebootReplicationInstanceError
    >
  >
> {}

export const RebootReplicationInstance =
  Binding.Service<RebootReplicationInstance>(
    "AWS.DMS.RebootReplicationInstance",
  );
