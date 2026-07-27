import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DeleteItemRequest extends Omit<
  DynamoDB.DeleteItemInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:DeleteItem`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that deletes a single item by key, automatically injecting the table name.
 * Provide the `DeleteItemHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Writing Data
 * @example Delete an Item by Key
 * ```typescript
 * const deleteItem = yield* AWS.DynamoDB.DeleteItem(table);
 *
 * yield* deleteItem({
 *   Key: {
 *     pk: { S: "user#123" },
 *     sk: { S: "profile" },
 *   },
 * });
 * ```
 */
export interface DeleteItem extends Binding.Service<
  DeleteItem,
  "AWS.DynamoDB.DeleteItem",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: DeleteItemRequest,
    ) => Effect.Effect<DynamoDB.DeleteItemOutput, DynamoDB.DeleteItemError>
  >
> {}

export const DeleteItem = Binding.Service<DeleteItem>(
  "AWS.DynamoDB.DeleteItem",
);
