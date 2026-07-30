import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ExecuteStatementRequest
  extends DynamoDB.ExecuteStatementInput {}

/**
 * Runtime binding for DynamoDB PartiQL `ExecuteStatement`.
 *
 * This binding scopes IAM to a specific table, but the statement text is still
 * user-provided. Statements must only reference the bound table or its indexes.
 * @binding
 * @section PartiQL
 * @example Execute a Statement Against One Table
 * ```typescript
 * const executeStatement = yield* AWS.DynamoDB.ExecuteStatement(table);
 *
 * const response = yield* executeStatement({
 *   Statement: `SELECT * FROM "${yield* table.tableName}" WHERE pk=?`,
 *   Parameters: [{ S: "user#1" }],
 * });
 * ```
 */
export interface ExecuteStatement extends Binding.Service<
  ExecuteStatement,
  "AWS.DynamoDB.ExecuteStatement",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: ExecuteStatementRequest,
    ) => Effect.Effect<
      DynamoDB.ExecuteStatementOutput,
      DynamoDB.ExecuteStatementError
    >
  >
> {}

export const ExecuteStatement = Binding.Service<ExecuteStatement>(
  "AWS.DynamoDB.ExecuteStatement",
);
