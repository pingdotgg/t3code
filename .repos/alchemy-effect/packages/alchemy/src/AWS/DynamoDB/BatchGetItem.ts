import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export type BatchGetItemTables = [Table, ...Table[]];

type BatchGetItemKeysAndAttributes = NonNullable<
  DynamoDB.BatchGetItemInput["RequestItems"]
>[string];

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
 * @binding
 * @section Reading Data
 * @example Read Items Across Multiple Tables
 * ```typescript
 * const batchGetItem = yield* BatchGetItem(sourceTable, archiveTable);
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
export interface BatchGetItem extends Binding.Service<
  BatchGetItem,
  "AWS.DynamoDB.BatchGetItem",
  (
    ...tables: BatchGetItemTables
  ) => Effect.Effect<
    (
      request: BatchGetItemRequest,
    ) => Effect.Effect<DynamoDB.BatchGetItemOutput, DynamoDB.BatchGetItemError>
  >
> {}
export const BatchGetItem = Binding.Service<BatchGetItem>(
  "AWS.DynamoDB.BatchGetItem",
);
