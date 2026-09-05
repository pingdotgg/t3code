import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface PutItemRequest extends Omit<
  DynamoDB.PutItemInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:PutItem`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that writes a single item, automatically injecting the table name and
 * granting the host `dynamodb:PutItem` on the table. Provide the `PutItemHttp`
 * layer on the Function to satisfy the binding.
 * @binding
 * @section Writing Data
 * @example Write a Single Item
 * ```typescript
 * // inside the Function's Effect.gen, with Effect.provide(DynamoDB.PutItemHttp)
 * const putItem = yield* AWS.DynamoDB.PutItem(table);
 *
 * yield* putItem({
 *   Item: {
 *     pk: { S: "user#123" },
 *     sk: { S: "profile" },
 *     name: { S: "Alice" },
 *   },
 * });
 * ```
 */
export interface PutItem extends Binding.Service<
  PutItem,
  "AWS.DynamoDB.PutItem",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: PutItemRequest,
    ) => Effect.Effect<DynamoDB.PutItemOutput, DynamoDB.PutItemError>
  >
> {}

export const PutItem = Binding.Service<PutItem>("AWS.DynamoDB.PutItem");
