import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface GetItemRequest extends Omit<
  DynamoDB.GetItemInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:GetItem`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that automatically injects the table name.
 * @binding
 * @section Reading Data
 * @example Read a Single Item
 * ```typescript
 * const getItem = yield* AWS.DynamoDB.GetItem(table);
 *
 * const response = yield* getItem({
 *   Key: {
 *     pk: { S: "user#123" },
 *   },
 * });
 * ```
 */
export interface GetItem extends Binding.Service<
  GetItem,
  "AWS.DynamoDB.GetItem",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: GetItemRequest,
    ) => Effect.Effect<DynamoDB.GetItemOutput, DynamoDB.GetItemError>
  >
> {}
export const GetItem = Binding.Service<GetItem>("AWS.DynamoDB.GetItem");
