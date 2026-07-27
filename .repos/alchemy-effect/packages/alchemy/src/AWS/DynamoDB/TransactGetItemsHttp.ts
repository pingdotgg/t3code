import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import {
  TransactGetItems,
  type TransactGetItemsRequest,
  type TransactGetItemsTables,
} from "./TransactGetItems.ts";

export const TransactGetItemsHttp = Layer.effect(
  TransactGetItems,
  Effect.gen(function* () {
    const transactGetItems = yield* DynamoDB.transactGetItems;

    return Effect.fn(function* (...tables: TransactGetItemsTables) {
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
              `TransactGetItems request references unbound table '${tableId}'`,
            ),
          );
        }
        return yield* TableName;
      });

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.TransactGetItems(${sortedTables}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:GetItem"],
                  Resource: sortedTables.map((table) => table.tableArn),
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.DynamoDB.TransactGetItems(${sortedTables})`)(
        function* (request: TransactGetItemsRequest) {
          const transactItems = yield* Effect.forEach(
            request.TransactItems,
            ({ Get }) =>
              Effect.gen(function* () {
                return {
                  Get: {
                    ...Get,
                    TableName: yield* getTableName(Get.Table),
                  },
                };
              }),
          );

          return yield* transactGetItems({
            ...request,
            TransactItems: transactItems,
          });
        },
      );
    });
  }),
);

const sortTables = (tables: TransactGetItemsTables) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as TransactGetItemsTables;
