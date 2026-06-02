import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

type TransactWriteItemsTables = [Table, ...Table[]];

type NativeTransactWriteItem = NonNullable<
  DynamoDB.TransactWriteItemsInput["TransactItems"]
>[number];

type NativeConditionCheck = NonNullable<
  NativeTransactWriteItem["ConditionCheck"]
>;
type NativeDelete = NonNullable<NativeTransactWriteItem["Delete"]>;
type NativePut = NonNullable<NativeTransactWriteItem["Put"]>;
type NativeUpdate = NonNullable<NativeTransactWriteItem["Update"]>;

const sortTables = (tables: TransactWriteItemsTables) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as TransactWriteItemsTables;

export interface BoundConditionCheck extends Omit<
  NativeConditionCheck,
  "TableName"
> {
  Table: string;
}

export interface BoundDelete extends Omit<NativeDelete, "TableName"> {
  Table: string;
}

export interface BoundPut extends Omit<NativePut, "TableName"> {
  Table: string;
}

export interface BoundUpdate extends Omit<NativeUpdate, "TableName"> {
  Table: string;
}

export interface BoundTransactWriteItem {
  ConditionCheck?: BoundConditionCheck;
  Delete?: BoundDelete;
  Put?: BoundPut;
  Update?: BoundUpdate;
}

export interface TransactWriteItemsRequest extends Omit<
  DynamoDB.TransactWriteItemsInput,
  "TransactItems"
> {
  TransactItems: Array<BoundTransactWriteItem>;
}

/**
 * Runtime binding for `dynamodb:TransactWriteItems`.
 *
 * Bind this operation to one or more tables and identify each item's target
 * table by the bound table's `LogicalId`.
 *
 * @section Writing Data
 * @example Write Items Transactionally
 * ```typescript
 * const transactWriteItems = yield* TransactWriteItems.bind(
 *   sourceTable,
 *   archiveTable,
 * );
 *
 * yield* transactWriteItems({
 *   TransactItems: [
 *     {
 *       Put: {
 *         Table: sourceTable.LogicalId,
 *         Item: { pk: { S: "user#1" }, sk: { S: "profile" } },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export class TransactWriteItems extends Binding.Service<
  TransactWriteItems,
  (
    ...tables: TransactWriteItemsTables
  ) => Effect.Effect<
    (
      request: TransactWriteItemsRequest,
    ) => Effect.Effect<
      DynamoDB.TransactWriteItemsOutput,
      DynamoDB.TransactWriteItemsError
    >
  >
>()("AWS.DynamoDB.TransactWriteItems") {}

export const TransactWriteItemsLive = Layer.effect(
  TransactWriteItems,
  Effect.gen(function* () {
    const Policy = yield* TransactWriteItemsPolicy;
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

      const getTableName = (tableId: string) => {
        const TableName = tableNames.get(tableId);
        if (!TableName) {
          throw new Error(
            `TransactWriteItems request references unbound table '${tableId}'`,
          );
        }
        return TableName;
      };

      yield* Policy(...sortedTables);

      return Effect.fn(function* (request: TransactWriteItemsRequest) {
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
              throw new Error(
                "TransactWriteItems request item must include one DynamoDB operation",
              );
            }),
        );

        return yield* transactWriteItems({
          ...request,
          TransactItems: transactItems,
        });
      });
    });
  }),
);

export class TransactWriteItemsPolicy extends Binding.Policy<
  TransactWriteItemsPolicy,
  (...tables: TransactWriteItemsTables) => Effect.Effect<void>
>()("AWS.DynamoDB.TransactWriteItems") {}

export const TransactWriteItemsPolicyLive =
  TransactWriteItemsPolicy.layer.succeed(
    Effect.fn(function* (host, ...tables: TransactWriteItemsTables) {
      const sortedTables = sortTables(tables);

      if (isFunction(host)) {
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
      } else {
        return yield* Effect.die(
          `TransactWriteItemsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
