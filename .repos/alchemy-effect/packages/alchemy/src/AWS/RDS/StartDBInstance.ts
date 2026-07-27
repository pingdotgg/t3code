import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBInstance } from "./DBInstance.ts";

/**
 * Runtime binding for the `StartDBInstance` operation (IAM action
 * `rds:StartDBInstance`).
 *
 * Starts the bound {@link DBInstance} after it was stopped — e.g. an ops
 * function that wakes a development database on a schedule. The instance
 * identifier is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RDS.StartDBInstanceHttp)`.
 * @binding
 * @section Operating an Instance
 * @example Start a Stopped Instance
 * ```typescript
 * // init — bind the operation to the instance
 * const startDBInstance = yield* AWS.RDS.StartDBInstance(instance);
 *
 * // runtime
 * yield* startDBInstance();
 * ```
 */
export interface StartDBInstance extends Binding.Service<
  StartDBInstance,
  "AWS.RDS.StartDBInstance",
  (
    instance: DBInstance,
  ) => Effect.Effect<
    () => Effect.Effect<rds.StartDBInstanceResult, rds.StartDBInstanceError>
  >
> {}
export const StartDBInstance = Binding.Service<StartDBInstance>(
  "AWS.RDS.StartDBInstance",
);
