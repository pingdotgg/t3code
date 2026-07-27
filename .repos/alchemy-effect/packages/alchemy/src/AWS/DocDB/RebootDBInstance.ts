import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBInstance } from "./DBInstance.ts";

/**
 * Runtime binding for the `RebootDBInstance` operation (IAM action
 * `rds:RebootDBInstance`).
 *
 * Reboots the bound {@link DBInstance} — e.g. an ops function applying a
 * parameter-group change that requires a restart. The instance identifier
 * is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.DocDB.RebootDBInstanceHttp)`.
 * @binding
 * @section Operating an Instance
 * @example Reboot an Instance
 * ```typescript
 * // init — bind the operation to the instance
 * const rebootDBInstance = yield* AWS.DocDB.RebootDBInstance(instance);
 *
 * // runtime — optionally force a failover during the reboot
 * yield* rebootDBInstance({ ForceFailover: false });
 * ```
 */
export interface RebootDBInstance extends Binding.Service<
  RebootDBInstance,
  "AWS.DocDB.RebootDBInstance",
  (
    instance: DBInstance,
  ) => Effect.Effect<
    (
      request?: Omit<docdb.RebootDBInstanceMessage, "DBInstanceIdentifier">,
    ) => Effect.Effect<
      docdb.RebootDBInstanceResult,
      docdb.RebootDBInstanceError
    >
  >
> {}
export const RebootDBInstance = Binding.Service<RebootDBInstance>(
  "AWS.DocDB.RebootDBInstance",
);
