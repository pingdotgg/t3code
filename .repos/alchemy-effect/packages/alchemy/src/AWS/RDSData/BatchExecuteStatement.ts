import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface BatchExecuteStatementOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface BatchExecuteStatementRequest extends Omit<
  rdsdata.BatchExecuteStatementRequest,
  "resourceArn" | "secretArn" | "database" | "schema"
> {}

/**
 * Runtime binding for `rds-data:BatchExecuteStatement` — run one SQL
 * statement over many parameter sets in a single Data API call (bulk
 * insert/update/delete).
 *
 * Bind it to a Data-API-enabled `DBCluster` and its credentials secret,
 * exactly like `AWS.RDSData.ExecuteStatement`; provide the implementation
 * with `Effect.provide(AWS.RDSData.BatchExecuteStatementHttp)`.
 * @binding
 * @section Batch Writes
 * @example Bulk Insert Rows
 * ```typescript
 * // init — bind alongside your other Data API operations
 * const batchExecuteStatement = yield* AWS.RDSData.BatchExecuteStatement(
 *   db.cluster,
 *   { secret: db.secret, database: "app" },
 * );
 *
 * // runtime — one statement, one parameter set per row
 * const result = yield* batchExecuteStatement({
 *   sql: "INSERT INTO todos (id, title) VALUES (:id, :title)",
 *   parameterSets: rows.map((row) => [
 *     { name: "id", value: { longValue: row.id } },
 *     { name: "title", value: { stringValue: row.title } },
 *   ]),
 * });
 * ```
 */
export interface BatchExecuteStatement extends Binding.Service<
  BatchExecuteStatement,
  "AWS.RDSData.BatchExecuteStatement",
  (
    cluster: DBCluster,
    options: BatchExecuteStatementOptions,
  ) => Effect.Effect<
    (
      request: BatchExecuteStatementRequest,
    ) => Effect.Effect<
      rdsdata.BatchExecuteStatementResponse,
      rdsdata.BatchExecuteStatementError,
      RuntimeContext
    >
  >
> {}

export const BatchExecuteStatement = Binding.Service<BatchExecuteStatement>(
  "AWS.RDSData.BatchExecuteStatement",
);
