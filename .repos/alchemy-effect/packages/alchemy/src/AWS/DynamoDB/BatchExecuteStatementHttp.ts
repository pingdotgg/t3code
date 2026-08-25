import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  BatchExecuteStatement,
  type BatchExecuteStatementRequest,
  type BatchExecuteStatementTables,
  sortBatchExecuteStatementTables,
} from "./BatchExecuteStatement.ts";

export const BatchExecuteStatementHttp = Layer.effect(
  BatchExecuteStatement,
  Effect.gen(function* () {
    const batchExecuteStatement = yield* DynamoDB.batchExecuteStatement;

    return Effect.fn(function* (...tables: BatchExecuteStatementTables) {
      const sortedTables = sortBatchExecuteStatementTables(tables);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
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
        }
      }
      return Effect.fn(`AWS.DynamoDB.BatchExecuteStatement(${sortedTables})`)(
        function* (request: BatchExecuteStatementRequest) {
          return yield* batchExecuteStatement(request);
        },
      );
    });
  }),
);
