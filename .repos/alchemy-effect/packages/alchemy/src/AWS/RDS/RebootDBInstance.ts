import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBInstance } from "./DBInstance.ts";

/**
 * Runtime binding for the `RebootDBInstance` operation (IAM action
 * `rds:RebootDBInstance`).
 *
 * Reboots the bound {@link DBInstance} (optionally with a forced
 * failover for Multi-AZ deployments) — e.g. to apply static parameter
 * changes. The instance identifier is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RDS.RebootDBInstanceHttp)`.
 * @binding
 * @section Operating an Instance
 * @example Reboot an Instance
 * ```typescript
 * // init — bind the operation to the instance
 * const rebootDBInstance = yield* AWS.RDS.RebootDBInstance(instance);
 *
 * // runtime
 * yield* rebootDBInstance();
 * ```
 */
export interface RebootDBInstance extends Binding.Service<
  RebootDBInstance,
  "AWS.RDS.RebootDBInstance",
  (
    instance: DBInstance,
  ) => Effect.Effect<
    (
      request?: Omit<rds.RebootDBInstanceMessage, "DBInstanceIdentifier">,
    ) => Effect.Effect<rds.RebootDBInstanceResult, rds.RebootDBInstanceError>
  >
> {}
export const RebootDBInstance = Binding.Service<RebootDBInstance>(
  "AWS.RDS.RebootDBInstance",
);
