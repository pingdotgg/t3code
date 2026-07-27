import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  BatchGetItem,
  type BatchGetItemRequest,
  type BatchGetItemTables,
} from "./BatchGetItem.ts";

export const BatchGetItemHttp = Layer.effect(
  BatchGetItem,
  Effect.gen(function* () {
    const batchGetItem = yield* DynamoDB.batchGetItem;

    return Effect.fn(function* (...tables: BatchGetItemTables) {
      const sortedTables = sortTables(tables);
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
              `BatchGetItem request references unbound table '${tableId}'`,
            ),
          );
        }
        return yield* TableName;
      });

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.BatchGetItem(${sortedTables}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:BatchGetItem"],
                  Resource: sortedTables.map((table) => table.tableArn),
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.DynamoDB.BatchGetItem(${sortedTables})`)(function* (
        request: BatchGetItemRequest,
      ) {
        const requestItems = yield* Effect.forEach(
          Object.entries(request.RequestItems),
          ([tableId, keys]) =>
            Effect.gen(function* () {
              return [yield* getTableName(tableId), keys] as const;
            }),
        );

        return yield* batchGetItem({
          ...request,
          RequestItems: Object.fromEntries(requestItems),
        });
      });
    });
  }),
);

const sortTables = (tables: BatchGetItemTables) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as BatchGetItemTables;
