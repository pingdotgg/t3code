import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Namespace } from "./Namespace.ts";

/**
 * Runtime binding for the `RestoreTableFromSnapshot` operation (IAM actions
 * `redshift-serverless:RestoreTableFromSnapshot`).
 *
 * Restores a single table from a snapshot into the bound
 * {@link Namespace} under a new name — undo for a bad table mutation
 * without rolling back the whole namespace. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.RestoreTableFromSnapshotHttp)`.
 * @binding
 * @section Restoring Data
 * @example Restore One Table from a Snapshot
 * ```typescript
 * // init — resolve the runtime client
 * const restoreTable = yield* AWS.RedshiftServerless.RestoreTableFromSnapshot(namespace);
 *
 * yield* restoreTable({
 *   workgroupName,
 *   snapshotName: "pre-migration-1",
 *   sourceDatabaseName: "dev",
 *   sourceTableName: "orders",
 *   newTableName: "orders_restored",
 * });
 * ```
 */
export interface RestoreTableFromSnapshot extends Binding.Service<
  RestoreTableFromSnapshot,
  "AWS.RedshiftServerless.RestoreTableFromSnapshot",
  (
    namespace: Namespace,
  ) => Effect.Effect<
    (
      request: Omit<
        serverless.RestoreTableFromSnapshotRequest,
        "namespaceName"
      >,
    ) => Effect.Effect<
      serverless.RestoreTableFromSnapshotResponse,
      serverless.RestoreTableFromSnapshotError
    >
  >
> {}
export const RestoreTableFromSnapshot =
  Binding.Service<RestoreTableFromSnapshot>(
    "AWS.RedshiftServerless.RestoreTableFromSnapshot",
  );
