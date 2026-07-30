import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface UpdateItemRequest extends Omit<
  DynamoDB.UpdateItemInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:UpdateItem`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that applies an update expression to a single item, automatically injecting
 * the table name. Provide the `UpdateItemHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Writing Data
 * @example Update an Item with an Update Expression
 * ```typescript
 * const updateItem = yield* AWS.DynamoDB.UpdateItem(table);
 *
 * const response = yield* updateItem({
 *   Key: {
 *     pk: { S: "user#123" },
 *     sk: { S: "profile" },
 *   },
 *   UpdateExpression: "SET #name = :name",
 *   ExpressionAttributeNames: { "#name": "name" },
 *   ExpressionAttributeValues: { ":name": { S: "Alice" } },
 *   ReturnValues: "ALL_NEW",
 * });
 * ```
 */
export interface UpdateItem extends Binding.Service<
  UpdateItem,
  "AWS.DynamoDB.UpdateItem",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: UpdateItemRequest,
    ) => Effect.Effect<DynamoDB.UpdateItemOutput, DynamoDB.UpdateItemError>
  >
> {}
export const UpdateItem = Binding.Service<UpdateItem>(
  "AWS.DynamoDB.UpdateItem",
);
