import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

type BatchWriteItemTables = [Table, ...Table[]];

type BatchWriteRequests = NonNullable<
  DynamoDB.BatchWriteItemInput["RequestItems"]
>[string];

const sortTables = (tables: BatchWriteItemTables) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as BatchWriteItemTables;

export interface BatchWriteItemRequest extends Omit<
  DynamoDB.BatchWriteItemInput,
  "RequestItems"
> {
  RequestItems: Record<string, BatchWriteRequests>;
}

/**
 * Runtime binding for `dynamodb:BatchWriteItem`.
 *
 * Bind this operation to one or more tables and key the request by each bound
 * table's `LogicalId`.
 *
 * @section Writing Data
 * @example Write Items Across Multiple Tables
 * ```typescript
 * const batchWriteItem = yield* BatchWriteItem.bind(sourceTable, archiveTable);
 *
 * const response = yield* batchWriteItem({
 *   RequestItems: {
 *     [sourceTable.LogicalId]: [
 *       {
 *         PutRequest: {
 *           Item: {
 *             pk: { S: "user#1" },
 *             sk: { S: "profile" },
 *           },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export class BatchWriteItem extends Binding.Service<
  BatchWriteItem,
  (
    ...tables: BatchWriteItemTables
  ) => Effect.Effect<
    (
      request: BatchWriteItemRequest,
    ) => Effect.Effect<
      DynamoDB.BatchWriteItemOutput,
      DynamoDB.BatchWriteItemError
    >
  >
>()("AWS.DynamoDB.BatchWriteItem") {}

export const BatchWriteItemLive = Layer.effect(
  BatchWriteItem,
  Effect.gen(function* () {
    const Policy = yield* BatchWriteItemPolicy;
    const batchWriteItem = yield* DynamoDB.batchWriteItem;

    return Effect.fn(function* (...tables: BatchWriteItemTables) {
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
            `BatchWriteItem request references unbound table '${tableId}'`,
          );
        }
        return TableName;
      };

      yield* Policy(...sortedTables);

      return Effect.fn(function* (request: BatchWriteItemRequest) {
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
      });
    });
  }),
);

export class BatchWriteItemPolicy extends Binding.Policy<
  BatchWriteItemPolicy,
  (...tables: BatchWriteItemTables) => Effect.Effect<void>
>()("AWS.DynamoDB.BatchWriteItem") {}

export const BatchWriteItemPolicyLive = BatchWriteItemPolicy.layer.succeed(
  Effect.fn(function* (host, ...tables: BatchWriteItemTables) {
    const sortedTables = sortTables(tables);

    if (isFunction(host)) {
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
    } else {
      return yield* Effect.die(
        `BatchWriteItemPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
