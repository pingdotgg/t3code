import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import {
  TransactGetItems,
  type TransactGetItemsRequest,
  type TransactGetItemsTables,
} from "./TransactGetItems.ts";

export const TransactGetItemsHttp = Layer.effect(
  TransactGetItems,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
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
            new Error(`TransactGetItems request references unbound table '${tableId}'`),
          );
        }
        return yield* TableName;
      });

      yield* grantTables(
        `AWS.DynamoDB.TransactGetItems(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:GetItem"],
            Resource: sortedTables.map((table) => table.tableArn),
          },
        ],
      );
      const transactGetItems = yield* AWSBindings.withCredentials(
        DynamoDB.transactGetItems,
        tablesRegion(sortedTables),
      );

      return Effect.fn(
        `AWS.DynamoDB.TransactGetItems(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
      )(function* (request: TransactGetItemsRequest) {
        const transactItems = yield* Effect.forEach(request.TransactItems, ({ Get }) =>
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
      });
    });
  }),
);

const sortTables = (tables: TransactGetItemsTables) =>
  [...new Map(tables.map((table) => [table.LogicalId, table] as const)).values()].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as TransactGetItemsTables;
