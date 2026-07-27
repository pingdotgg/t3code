import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DBInstance } from "./DBInstance.ts";

/**
 * Runtime binding for the `CreateDBSnapshot` operation (IAM actions
 * `rds:CreateDBSnapshot` +
 * `rds:AddTagsToResource`).
 *
 * Takes a manual snapshot of the bound {@link DBInstance} — e.g. a
 * pre-migration backup function or a scheduled snapshot-rotation job. The
 * instance identifier is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RDS.CreateDBSnapshotHttp)`.
 * @binding
 * @section Managing Instance Snapshots
 * @example Take a Manual Instance Snapshot
 * ```typescript
 * // init — bind the operation to the instance
 * const createDBSnapshot = yield* AWS.RDS.CreateDBSnapshot(instance);
 *
 * // runtime
 * yield* createDBSnapshot({
 *   DBSnapshotIdentifier: `pre-migration-${runId}`,
 * });
 * ```
 */
export interface CreateDBSnapshot extends Binding.Service<
  CreateDBSnapshot,
  "AWS.RDS.CreateDBSnapshot",
  (
    instance: DBInstance,
  ) => Effect.Effect<
    (
      request: Omit<rds.CreateDBSnapshotMessage, "DBInstanceIdentifier">,
    ) => Effect.Effect<rds.CreateDBSnapshotResult, rds.CreateDBSnapshotError>
  >
> {}
export const CreateDBSnapshot = Binding.Service<CreateDBSnapshot>(
  "AWS.RDS.CreateDBSnapshot",
);
