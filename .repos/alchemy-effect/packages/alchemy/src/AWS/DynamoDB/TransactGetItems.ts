import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export type TransactGetItemsTables = [Table, ...Table[]];

type NativeTransactGet = NonNullable<
  NonNullable<DynamoDB.TransactGetItemsInput["TransactItems"]>[number]["Get"]
>;

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
 * @binding
 * @section Reading Data
 * @example Read Items Transactionally
 * ```typescript
 * const transactGetItems = yield* AWS.DynamoDB.TransactGetItems(
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
export interface TransactGetItems extends Binding.Service<
  TransactGetItems,
  "AWS.DynamoDB.TransactGetItems",
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
> {}
export const TransactGetItems = Binding.Service<TransactGetItems>(
  "AWS.DynamoDB.TransactGetItems",
);
