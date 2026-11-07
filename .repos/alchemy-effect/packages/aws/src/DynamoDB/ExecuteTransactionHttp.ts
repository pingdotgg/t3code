import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import {
  ExecuteTransaction,
  type ExecuteTransactionRequest,
  type ExecuteTransactionTables,
} from "./ExecuteTransaction.ts";

export const ExecuteTransactionHttp = Layer.effect(
  ExecuteTransaction,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (...tables: ExecuteTransactionTables) {
      const sortedTables = [...tables].sort((a, b) => a.LogicalId.localeCompare(b.LogicalId));
      yield* grantTables(
        `AWS.DynamoDB.ExecuteTransaction(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
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
      );
      const executeTransaction = yield* AWSBindings.withCredentials(
        DynamoDB.executeTransaction,
        tablesRegion(sortedTables),
      );
      return Effect.fn(
        `AWS.DynamoDB.ExecuteTransaction(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
      )(function* (request: ExecuteTransactionRequest) {
        return yield* executeTransaction(request);
      });
    });
  }),
);
