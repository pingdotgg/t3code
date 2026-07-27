import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface BeginTransactionOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

/**
 * Runtime binding for `rds-data:BeginTransaction` — open a Data API
 * transaction and get back a `transactionId` to thread through subsequent
 * `ExecuteStatement`/`BatchExecuteStatement` calls.
 *
 * Bind it to a Data-API-enabled `DBCluster` and its credentials secret;
 * provide the implementation with
 * `Effect.provide(AWS.RDSData.BeginTransactionHttp)`. Pair with
 * `AWS.RDSData.CommitTransaction` / `AWS.RDSData.RollbackTransaction` to
 * finish the transaction.
 * @binding
 * @section Transactions
 * @example Begin, Write, Commit
 * ```typescript
 * // init
 * const beginTransaction = yield* AWS.RDSData.BeginTransaction(db.cluster, {
 *   secret: db.secret,
 *   database: "app",
 * });
 * const executeStatement = yield* AWS.RDSData.ExecuteStatement(db.cluster, {
 *   secret: db.secret,
 *   database: "app",
 * });
 * const commitTransaction = yield* AWS.RDSData.CommitTransaction(db.cluster, {
 *   secret: db.secret,
 * });
 *
 * // runtime
 * const tx = yield* beginTransaction();
 * yield* executeStatement({
 *   sql: "INSERT INTO todos (id, title) VALUES (:id, :title)",
 *   parameters: [
 *     { name: "id", value: { longValue: 1 } },
 *     { name: "title", value: { stringValue: "buy milk" } },
 *   ],
 *   transactionId: tx.transactionId,
 * });
 * yield* commitTransaction({ transactionId: tx.transactionId! });
 * ```
 */
export interface BeginTransaction extends Binding.Service<
  BeginTransaction,
  "AWS.RDSData.BeginTransaction",
  (
    cluster: DBCluster,
    options: BeginTransactionOptions,
  ) => Effect.Effect<
    () => Effect.Effect<
      rdsdata.BeginTransactionResponse,
      rdsdata.BeginTransactionError,
      RuntimeContext
    >
  >
> {}

export const BeginTransaction = Binding.Service<BeginTransaction>(
  "AWS.RDSData.BeginTransaction",
);
