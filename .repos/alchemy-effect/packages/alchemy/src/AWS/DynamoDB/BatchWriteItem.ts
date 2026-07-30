import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export type BatchWriteItemTables = [Table, ...Table[]];

type BatchWriteRequests = NonNullable<
  DynamoDB.BatchWriteItemInput["RequestItems"]
>[string];

export const sortBatchWriteItemTables = (tables: BatchWriteItemTables) =>
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
 * @binding
 * @section Writing Data
 * @example Write Items Across Multiple Tables
 * ```typescript
 * const batchWriteItem = yield* AWS.DynamoDB.BatchWriteItem(sourceTable, archiveTable);
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
export interface BatchWriteItem extends Binding.Service<
  BatchWriteItem,
  "AWS.DynamoDB.BatchWriteItem",
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
> {}

export const BatchWriteItem = Binding.Service<BatchWriteItem>(
  "AWS.DynamoDB.BatchWriteItem",
);
