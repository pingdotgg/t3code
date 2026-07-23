import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

type BatchGetItemTables = [Table, ...Table[]];

type BatchGetItemKeysAndAttributes = NonNullable<
  DynamoDB.BatchGetItemInput["RequestItems"]
>[string];

const sortTables = (tables: BatchGetItemTables) =>
  [
    ...new Map(
      tables.map((table) => [table.LogicalId, table] as const),
    ).values(),
  ].sort((a, b) =>
    a.LogicalId.localeCompare(b.LogicalId),
  ) as BatchGetItemTables;

export interface BatchGetItemRequest extends Omit<
  DynamoDB.BatchGetItemInput,
  "RequestItems"
> {
  RequestItems: Record<string, BatchGetItemKeysAndAttributes>;
}

/**
 * Runtime binding for `dynamodb:BatchGetItem`.
 *
 * Bind this operation to one or more tables and key the request by each bound
 * table's `LogicalId`. The binding resolves those logical IDs to physical table
 * names at runtime.
 *
 * @section Reading Data
 * @example Read Items Across Multiple Tables
 * ```typescript
 * const batchGetItem = yield* BatchGetItem.bind(sourceTable, archiveTable);
 *
 * const response = yield* batchGetItem({
 *   RequestItems: {
 *     [sourceTable.LogicalId]: {
 *       Keys: [{ pk: { S: "user#1" }, sk: { S: "profile" } }],
 *     },
 *     [archiveTable.LogicalId]: {
 *       Keys: [{ pk: { S: "user#1" }, sk: { S: "profile" } }],
 *     },
 *   },
 * });
 * ```
 */
export class BatchGetItem extends Binding.Service<
  BatchGetItem,
  (
    ...tables: BatchGetItemTables
  ) => Effect.Effect<
    (
      request: BatchGetItemRequest,
    ) => Effect.Effect<DynamoDB.BatchGetItemOutput, DynamoDB.BatchGetItemError>
  >
>()("AWS.DynamoDB.BatchGetItem") {}

export const BatchGetItemLive = Layer.effect(
  BatchGetItem,
  Effect.gen(function* () {
    const Policy = yield* BatchGetItemPolicy;
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

      const getTableName = (tableId: string) => {
        const TableName = tableNames.get(tableId);
        if (!TableName) {
          throw new Error(
            `BatchGetItem request references unbound table '${tableId}'`,
          );
        }
        return TableName;
      };

      yield* Policy(...sortedTables);

      return Effect.fn(function* (request: BatchGetItemRequest) {
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

export class BatchGetItemPolicy extends Binding.Policy<
  BatchGetItemPolicy,
  (...tables: BatchGetItemTables) => Effect.Effect<void>
>()("AWS.DynamoDB.BatchGetItem") {}

export const BatchGetItemPolicyLive = BatchGetItemPolicy.layer.succeed(
  Effect.fn(function* (host, ...tables: BatchGetItemTables) {
    const sortedTables = sortTables(tables);

    if (isFunction(host)) {
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
    } else {
      return yield* Effect.die(
        `BatchGetItemPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
