import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Namespace } from "./Namespace.ts";

/**
 * Runtime binding for the `RestoreTableFromRecoveryPoint` operation (IAM actions
 * `redshift-serverless:RestoreTableFromRecoveryPoint`).
 *
 * Restores a single table from an automatic recovery point into the bound
 * {@link Namespace} under a new name. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.RestoreTableFromRecoveryPointHttp)`.
 * @binding
 * @section Restoring Data
 * @example Restore One Table from a Recovery Point
 * ```typescript
 * // init — resolve the runtime client
 * const restoreTable = yield* AWS.RedshiftServerless.RestoreTableFromRecoveryPoint(namespace);
 *
 * yield* restoreTable({
 *   workgroupName,
 *   recoveryPointId,
 *   sourceDatabaseName: "dev",
 *   sourceTableName: "orders",
 *   newTableName: "orders_restored",
 * });
 * ```
 */
export interface RestoreTableFromRecoveryPoint extends Binding.Service<
  RestoreTableFromRecoveryPoint,
  "AWS.RedshiftServerless.RestoreTableFromRecoveryPoint",
  (
    namespace: Namespace,
  ) => Effect.Effect<
    (
      request: Omit<
        serverless.RestoreTableFromRecoveryPointRequest,
        "namespaceName"
      >,
    ) => Effect.Effect<
      serverless.RestoreTableFromRecoveryPointResponse,
      serverless.RestoreTableFromRecoveryPointError
    >
  >
> {}
export const RestoreTableFromRecoveryPoint =
  Binding.Service<RestoreTableFromRecoveryPoint>(
    "AWS.RedshiftServerless.RestoreTableFromRecoveryPoint",
  );
