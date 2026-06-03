import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

type TransactGetItemsTables = [Table, ...Table[]];

type NativeTransactGet = NonNullable<
  NonNullable<DynamoDB.TransactGetItemsInput["TransactItems"]>[number]["Get"]
>;

const sortTables = (tables: TransactGetItemsTables) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as TransactGetItemsTables;

export interface TransactGet extends Omit<NativeTransactGet, "TableName"> {
  Table: string;
}

export interface TransactGetItemsRequest extends Omit<
  DynamoDB.TransactGetItemsInput,
  "TransactItems"
> {
  TransactItems: Array<{
    Get: TransactGet;
  }>;
}

/**
 * Runtime binding for `dynamodb:TransactGetItems`.
 *
 * Bind this operation to one or more tables and identify each table in the
 * request with the bound table's `LogicalId`.
 *
 * @section Reading Data
 * @example Read Items Transactionally
 * ```typescript
 * const transactGetItems = yield* TransactGetItems.bind(
 *   sourceTable,
 *   archiveTable,
 * );
 *
 * const response = yield* transactGetItems({
 *   TransactItems: [
 *     {
 *       Get: {
 *         Table: sourceTable.LogicalId,
 *         Key: { pk: { S: "user#1" }, sk: { S: "profile" } },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export class TransactGetItems extends Binding.Service<
  TransactGetItems,
  (
    ...tables: TransactGetItemsTables
  ) => Effect.Effect<
    (
      request: TransactGetItemsRequest,
    ) => Effect.Effect<
      DynamoDB.TransactGetItemsOutput,
      DynamoDB.TransactGetItemsError
    >
  >
>()("AWS.DynamoDB.TransactGetItems") {}

export const TransactGetItemsLive = Layer.effect(
  TransactGetItems,
  Effect.gen(function* () {
    const Policy = yield* TransactGetItemsPolicy;
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

      const getTableName = (tableId: string) => {
        const TableName = tableNames.get(tableId);
        if (!TableName) {
          throw new Error(
            `TransactGetItems request references unbound table '${tableId}'`,
          );
        }
        return TableName;
      };

      yield* Policy(...sortedTables);

      return Effect.fn(function* (request: TransactGetItemsRequest) {
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
      });
    });
  }),
);

export class TransactGetItemsPolicy extends Binding.Policy<
  TransactGetItemsPolicy,
  (...tables: TransactGetItemsTables) => Effect.Effect<void>
>()("AWS.DynamoDB.TransactGetItems") {}

export const TransactGetItemsPolicyLive = TransactGetItemsPolicy.layer.succeed(
  Effect.fn(function* (host, ...tables: TransactGetItemsTables) {
    const sortedTables = sortTables(tables);

    if (isFunction(host)) {
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
    } else {
      return yield* Effect.die(
        `TransactGetItemsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
