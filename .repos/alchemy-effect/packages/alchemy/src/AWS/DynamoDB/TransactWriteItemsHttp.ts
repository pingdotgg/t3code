import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  TransactWriteItems,
  type TransactWriteItemsRequest,
  type TransactWriteItemsTables,
} from "./TransactWriteItems.ts";

export const TransactWriteItemsHttp = Layer.effect(
  TransactWriteItems,
  Effect.gen(function* () {
    const transactWriteItems = yield* DynamoDB.transactWriteItems;

    return Effect.fn(function* (...tables: TransactWriteItemsTables) {
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
              `TransactWriteItems request references unbound table '${tableId}'`,
            ),
          );
        }
        return yield* TableName;
      });

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.TransactWriteItems(${sortedTables}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "dynamodb:ConditionCheckItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                  ],
                  Resource: sortedTables.map((table) => table.tableArn),
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.DynamoDB.TransactWriteItems(${sortedTables})`)(
        function* (request: TransactWriteItemsRequest) {
          const transactItems = yield* Effect.forEach(
            request.TransactItems,
            (item) =>
              Effect.gen(function* () {
                if (item.ConditionCheck) {
                  return {
                    ConditionCheck: {
                      ...item.ConditionCheck,
                      TableName: yield* getTableName(item.ConditionCheck.Table),
                    },
                  };
                }
                if (item.Delete) {
                  return {
                    Delete: {
                      ...item.Delete,
                      TableName: yield* getTableName(item.Delete.Table),
                    },
                  };
                }
                if (item.Put) {
                  return {
                    Put: {
                      ...item.Put,
                      TableName: yield* getTableName(item.Put.Table),
                    },
                  };
                }
                if (item.Update) {
                  return {
                    Update: {
                      ...item.Update,
                      TableName: yield* getTableName(item.Update.Table),
                    },
                  };
                }
                return yield* Effect.die(
                  new Error(
                    "TransactWriteItems request item must include one DynamoDB operation",
                  ),
                );
              }),
          );

          return yield* transactWriteItems({
            ...request,
            TransactItems: transactItems,
          });
        },
      );
    });
  }),
);

const sortTables = (tables: TransactWriteItemsTables) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as TransactWriteItemsTables;
