import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface CommitTransactionOptions {
  secret: Secret;
}

export interface CommitTransactionRequest extends Omit<
  rdsdata.CommitTransactionRequest,
  "resourceArn" | "secretArn"
> {}

/**
 * Runtime binding for `rds-data:CommitTransaction` — commit a Data API
 * transaction opened with `AWS.RDSData.BeginTransaction`.
 *
 * Bind it to the same `DBCluster` and credentials secret as the rest of the
 * transaction; provide the implementation with
 * `Effect.provide(AWS.RDSData.CommitTransactionHttp)`.
 * @binding
 * @section Transactions
 * @example Commit a Transaction
 * ```typescript
 * // init
 * const commitTransaction = yield* AWS.RDSData.CommitTransaction(db.cluster, {
 *   secret: db.secret,
 * });
 *
 * // runtime — after statements executed with tx.transactionId
 * const commit = yield* commitTransaction({ transactionId: tx.transactionId! });
 * // commit.transactionStatus === "Transaction Committed"
 * ```
 */
export interface CommitTransaction extends Binding.Service<
  CommitTransaction,
  "AWS.RDSData.CommitTransaction",
  (
    cluster: DBCluster,
    options: CommitTransactionOptions,
  ) => Effect.Effect<
    (
      request: CommitTransactionRequest,
    ) => Effect.Effect<
      rdsdata.CommitTransactionResponse,
      rdsdata.CommitTransactionError,
      RuntimeContext
    >
  >
> {}

export const CommitTransaction = Binding.Service<CommitTransaction>(
  "AWS.RDSData.CommitTransaction",
);
