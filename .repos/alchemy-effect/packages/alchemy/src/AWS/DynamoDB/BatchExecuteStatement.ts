import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export type BatchExecuteStatementTables = [Table, ...Table[]];

export const sortBatchExecuteStatementTables = (
  tables: BatchExecuteStatementTables,
) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as BatchExecuteStatementTables;

export interface BatchExecuteStatementRequest
  extends DynamoDB.BatchExecuteStatementInput {}

/**
 * Runtime binding for DynamoDB PartiQL `BatchExecuteStatement`.
 *
 * The request is passed through unchanged, but IAM is scoped to the explicitly
 * bound tables and their indexes.
 * @binding
 * @section PartiQL
 * @example Execute a Batch of Statements
 * ```typescript
 * const batchExecuteStatement = yield* AWS.DynamoDB.BatchExecuteStatement(
 *   sourceTable,
 *   archiveTable,
 * );
 *
 * const response = yield* batchExecuteStatement({
 *   Statements: [
 *     {
 *       Statement: `SELECT * FROM "${yield* sourceTable.tableName}" WHERE pk=?`,
 *       Parameters: [{ S: "user#1" }],
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchExecuteStatement extends Binding.Service<
  BatchExecuteStatement,
  "AWS.DynamoDB.BatchExecuteStatement",
  (
    ...tables: BatchExecuteStatementTables
  ) => Effect.Effect<
    (
      request: BatchExecuteStatementRequest,
    ) => Effect.Effect<
      DynamoDB.BatchExecuteStatementOutput,
      DynamoDB.BatchExecuteStatementError
    >
  >
> {}

export const BatchExecuteStatement = Binding.Service<BatchExecuteStatement>(
  "AWS.DynamoDB.BatchExecuteStatement",
);
