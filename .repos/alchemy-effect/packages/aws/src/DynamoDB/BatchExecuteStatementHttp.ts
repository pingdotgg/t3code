import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import {
  BatchExecuteStatement,
  type BatchExecuteStatementRequest,
  type BatchExecuteStatementTables,
  sortBatchExecuteStatementTables,
} from "./BatchExecuteStatement.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";

export const BatchExecuteStatementHttp = Layer.effect(
  BatchExecuteStatement,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (...tables: BatchExecuteStatementTables) {
      const sortedTables = sortBatchExecuteStatementTables(tables);
      yield* grantTables(
        `AWS.DynamoDB.BatchExecuteStatement(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
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
      );
      const batchExecuteStatement = yield* AWSBindings.withCredentials(
        DynamoDB.batchExecuteStatement,
        tablesRegion(sortedTables),
      );
      return Effect.fn(
        `AWS.DynamoDB.BatchExecuteStatement(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
      )(function* (request: BatchExecuteStatementRequest) {
        return yield* batchExecuteStatement(request);
      });
    });
  }),
);
