import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

type BatchExecuteStatementTables = [Table, ...Table[]];

const sortTables = (tables: BatchExecuteStatementTables) =>
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
 *
 * @section PartiQL
 * @example Execute a Batch of Statements
 * ```typescript
 * const batchExecuteStatement = yield* BatchExecuteStatement.bind(
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
export class BatchExecuteStatement extends Binding.Service<
  BatchExecuteStatement,
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
>()("AWS.DynamoDB.BatchExecuteStatement") {}

export const BatchExecuteStatementLive = Layer.effect(
  BatchExecuteStatement,
  Effect.gen(function* () {
    const Policy = yield* BatchExecuteStatementPolicy;
    const batchExecuteStatement = yield* DynamoDB.batchExecuteStatement;

    return Effect.fn(function* (...tables: BatchExecuteStatementTables) {
      const sortedTables = sortTables(tables);
      yield* Policy(...sortedTables);
      return Effect.fn(function* (request: BatchExecuteStatementRequest) {
        return yield* batchExecuteStatement(request);
      });
    });
  }),
);

export class BatchExecuteStatementPolicy extends Binding.Policy<
  BatchExecuteStatementPolicy,
  (...tables: BatchExecuteStatementTables) => Effect.Effect<void>
>()("AWS.DynamoDB.BatchExecuteStatement") {}

export const BatchExecuteStatementPolicyLive =
  BatchExecuteStatementPolicy.layer.succeed(
    Effect.fn(function* (host, ...tables: BatchExecuteStatementTables) {
      const sortedTables = sortTables(tables);

      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.DynamoDB.BatchExecuteStatement(${sortedTables}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "dynamodb:PartiQLDelete",
                  "dynamodb:PartiQLInsert",
                  "dynamodb:PartiQLSelect",
                  "dynamodb:PartiQLUpdate",
                ],
                Resource: sortedTables.flatMap((table) => [
                  table.tableArn,
                  Output.interpolate`${table.tableArn}/index/*`,
                ]),
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `BatchExecuteStatementPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
