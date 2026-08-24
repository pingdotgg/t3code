import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ExecuteTransaction,
  type ExecuteTransactionRequest,
  type ExecuteTransactionTables,
} from "./ExecuteTransaction.ts";

export const ExecuteTransactionHttp = Layer.effect(
  ExecuteTransaction,
  Effect.gen(function* () {
    const executeTransaction = yield* DynamoDB.executeTransaction;

    return Effect.fn(function* (...tables: ExecuteTransactionTables) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const sortedTables = [...tables].sort((a, b) =>
          a.LogicalId.localeCompare(b.LogicalId),
        );
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.ExecuteTransaction(${sortedTables}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "dynamodb:PartiQLSelect",
                    "dynamodb:PartiQLInsert",
                    "dynamodb:PartiQLUpdate",
                    "dynamodb:PartiQLDelete",
                  ],
                  Resource: sortedTables.map((table) => table.tableArn),
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.DynamoDB.ExecuteTransaction(${tables})`)(function* (
        request: ExecuteTransactionRequest,
      ) {
        return yield* executeTransaction(request);
      });
    });
  }),
);
