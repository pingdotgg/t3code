import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBInstance } from "./DBInstance.ts";

/**
 * Runtime binding for the `StopDBInstance` operation (IAM action
 * `rds:StopDBInstance`).
 *
 * Stops the bound {@link DBInstance} — e.g. an ops function that parks a
 * development database overnight to save cost. The instance identifier is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RDS.StopDBInstanceHttp)`.
 * @binding
 * @section Operating an Instance
 * @example Stop a Running Instance
 * ```typescript
 * // init — bind the operation to the instance
 * const stopDBInstance = yield* AWS.RDS.StopDBInstance(instance);
 *
 * // runtime
 * yield* stopDBInstance();
 * ```
 */
export interface StopDBInstance extends Binding.Service<
  StopDBInstance,
  "AWS.RDS.StopDBInstance",
  (
    instance: DBInstance,
  ) => Effect.Effect<
    (
      request?: Omit<rds.StopDBInstanceMessage, "DBInstanceIdentifier">,
    ) => Effect.Effect<rds.StopDBInstanceResult, rds.StopDBInstanceError>
  >
> {}
export const StopDBInstance = Binding.Service<StopDBInstance>(
  "AWS.RDS.StopDBInstance",
);
