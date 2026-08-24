import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  BatchWriteItem,
  type BatchWriteItemRequest,
  type BatchWriteItemTables,
  sortBatchWriteItemTables,
} from "./BatchWriteItem.ts";

export const BatchWriteItemHttp = Layer.effect(
  BatchWriteItem,
  Effect.gen(function* () {
    const batchWriteItem = yield* DynamoDB.batchWriteItem;

    return Effect.fn(function* (...tables: BatchWriteItemTables) {
      const sortedTables = sortBatchWriteItemTables(tables);
      const tableNames = new Map(
        yield* Effect.forEach(sortedTables, (table) =>
          Effect.gen(function* () {
            return [table.LogicalId, yield* table.tableName] as const;
          }),
        ),
      );

      const getTableName = Effect.fn(function* (tableId: string) {
        const TableName = tableNames.get(tableId);
        if (!TableName) {
          return yield* Effect.die(
            new Error(
              `BatchWriteItem request references unbound table '${tableId}'`,
            ),
          );
        }
        return yield* TableName;
      });

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.BatchWriteItem(${sortedTables}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:BatchWriteItem"],
                  Resource: sortedTables.map((table) => table.tableArn),
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.DynamoDB.BatchWriteItem(${sortedTables})`)(
        function* (request: BatchWriteItemRequest) {
          const requestItems = yield* Effect.forEach(
            Object.entries(request.RequestItems),
            ([tableId, writes]) =>
              Effect.gen(function* () {
                return [yield* getTableName(tableId), writes] as const;
              }),
          );

          return yield* batchWriteItem({
            ...request,
            RequestItems: Object.fromEntries(requestItems),
          });
        },
      );
    });
  }),
);
