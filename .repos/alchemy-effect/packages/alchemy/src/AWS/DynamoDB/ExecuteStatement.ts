import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface ExecuteStatementRequest
  extends DynamoDB.ExecuteStatementInput {}

/**
 * Runtime binding for DynamoDB PartiQL `ExecuteStatement`.
 *
 * This binding scopes IAM to a specific table, but the statement text is still
 * user-provided. Statements must only reference the bound table or its indexes.
 *
 * @section PartiQL
 * @example Execute a Statement Against One Table
 * ```typescript
 * const executeStatement = yield* ExecuteStatement.bind(table);
 *
 * const response = yield* executeStatement({
 *   Statement: `SELECT * FROM "${yield* table.tableName}" WHERE pk=?`,
 *   Parameters: [{ S: "user#1" }],
 * });
 * ```
 */
export class ExecuteStatement extends Binding.Service<
  ExecuteStatement,
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
>()("AWS.DynamoDB.ExecuteStatement") {}

export const ExecuteStatementLive = Layer.effect(
  ExecuteStatement,
  Effect.gen(function* () {
    const Policy = yield* ExecuteStatementPolicy;
    const executeStatement = yield* DynamoDB.executeStatement;

    return Effect.fn(function* <T extends Table>(table: T) {
      yield* Policy(table);
      return Effect.fn(function* (request: ExecuteStatementRequest) {
        return yield* executeStatement(request);
      });
    });
  }),
);

export class ExecuteStatementPolicy extends Binding.Policy<
  ExecuteStatementPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.ExecuteStatement") {}

export const ExecuteStatementPolicyLive = ExecuteStatementPolicy.layer.succeed(
  Effect.fn(function* (host, table) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.DynamoDB.ExecuteStatement(${table}))`(
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
              Resource: [
                table.tableArn,
                Output.interpolate`${table.tableArn}/index/*`,
              ],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `ExecuteStatementPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
