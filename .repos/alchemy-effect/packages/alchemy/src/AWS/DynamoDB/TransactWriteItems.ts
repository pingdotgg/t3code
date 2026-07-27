import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export type TransactWriteItemsTables = [Table, ...Table[]];

type NativeTransactWriteItem = NonNullable<
  DynamoDB.TransactWriteItemsInput["TransactItems"]
>[number];

type NativeConditionCheck = NonNullable<
  NativeTransactWriteItem["ConditionCheck"]
>;
type NativeDelete = NonNullable<NativeTransactWriteItem["Delete"]>;
type NativePut = NonNullable<NativeTransactWriteItem["Put"]>;
type NativeUpdate = NonNullable<NativeTransactWriteItem["Update"]>;

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
 * @binding
 * @section Writing Data
 * @example Write Items Transactionally
 * ```typescript
 * const transactWriteItems = yield* AWS.DynamoDB.TransactWriteItems(
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
export interface TransactWriteItems extends Binding.Service<
  TransactWriteItems,
  "AWS.DynamoDB.TransactWriteItems",
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
> {}

export const TransactWriteItems = Binding.Service<TransactWriteItems>(
  "AWS.DynamoDB.TransactWriteItems",
);
