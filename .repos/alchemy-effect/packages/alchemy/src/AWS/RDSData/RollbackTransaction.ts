import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface RollbackTransactionOptions {
  secret: Secret;
}

export interface RollbackTransactionRequest extends Omit<
  rdsdata.RollbackTransactionRequest,
  "resourceArn" | "secretArn"
> {}

/**
 * Runtime binding for `rds-data:RollbackTransaction` — roll back a Data API
 * transaction opened with `AWS.RDSData.BeginTransaction`, discarding every
 * statement executed under its `transactionId`.
 *
 * Bind it to the same `DBCluster` and credentials secret as the rest of the
 * transaction; provide the implementation with
 * `Effect.provide(AWS.RDSData.RollbackTransactionHttp)`.
 * @binding
 * @section Transactions
 * @example Roll Back on Failure
 * ```typescript
 * // init
 * const rollbackTransaction = yield* AWS.RDSData.RollbackTransaction(
 *   db.cluster,
 *   { secret: db.secret },
 * );
 *
 * // runtime — abandon the transaction; its inserts never become visible
 * const rollback = yield* rollbackTransaction({
 *   transactionId: tx.transactionId!,
 * });
 * // rollback.transactionStatus === "Rollback Complete"
 * ```
 */
export interface RollbackTransaction extends Binding.Service<
  RollbackTransaction,
  "AWS.RDSData.RollbackTransaction",
  (
    cluster: DBCluster,
    options: RollbackTransactionOptions,
  ) => Effect.Effect<
    (
      request: RollbackTransactionRequest,
    ) => Effect.Effect<
      rdsdata.RollbackTransactionResponse,
      rdsdata.RollbackTransactionError,
      RuntimeContext
    >
  >
> {}

export const RollbackTransaction = Binding.Service<RollbackTransaction>(
  "AWS.RDSData.RollbackTransaction",
);
