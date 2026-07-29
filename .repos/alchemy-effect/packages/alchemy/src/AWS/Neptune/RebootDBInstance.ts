import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBInstance } from "./DBInstance.ts";

/**
 * Runtime binding for the `RebootDBInstance` operation (IAM action
 * `rds:RebootDBInstance`).
 *
 * Reboots the bound {@link DBInstance} — e.g. to apply a static parameter
 * change from an ops function. The instance identifier is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.Neptune.RebootDBInstanceHttp)`.
 * @binding
 * @section Operating a Cluster
 * @example Reboot an Instance
 * ```typescript
 * // init — bind the operation to the instance
 * const rebootDBInstance = yield* AWS.Neptune.RebootDBInstance(instance);
 *
 * // runtime
 * yield* rebootDBInstance();
 * ```
 */
export interface RebootDBInstance extends Binding.Service<
  RebootDBInstance,
  "AWS.Neptune.RebootDBInstance",
  (
    instance: DBInstance,
  ) => Effect.Effect<
    (
      request?: Omit<neptune.RebootDBInstanceMessage, "DBInstanceIdentifier">,
    ) => Effect.Effect<
      neptune.RebootDBInstanceResult,
      neptune.RebootDBInstanceError
    >
  >
> {}
export const RebootDBInstance = Binding.Service<RebootDBInstance>(
  "AWS.Neptune.RebootDBInstance",
);
