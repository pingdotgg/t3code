import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface QueryRequest extends Omit<DynamoDB.QueryInput, "TableName"> {}

/**
 * Runtime binding for `dynamodb:Query`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that queries items by key condition, automatically injecting the table name.
 * Provide the `QueryHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Reading Data
 * @example Query Items by Partition Key
 * ```typescript
 * const query = yield* AWS.DynamoDB.Query(table);
 *
 * const response = yield* query({
 *   KeyConditionExpression: "pk = :pk",
 *   ExpressionAttributeValues: { ":pk": { S: "user#123" } },
 * });
 * const items = response.Items;
 * ```
 */
export interface Query extends Binding.Service<
  Query,
  "AWS.DynamoDB.Query",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: QueryRequest,
    ) => Effect.Effect<DynamoDB.QueryOutput, DynamoDB.QueryError>
  >
> {}
export const Query = Binding.Service<Query>("AWS.DynamoDB.Query");
