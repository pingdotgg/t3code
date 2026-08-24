import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ListTagsOfResourceRequest extends Omit<
  DynamoDB.ListTagsOfResourceInput,
  "ResourceArn"
> {}

/**
 * Runtime binding for `dynamodb:ListTagsOfResource`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that lists the table's tags, automatically injecting the table ARN. Provide
 * the `ListTagsOfResourceHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Table Metadata
 * @example List the Bound Table's Tags
 * ```typescript
 * const listTagsOfResource = yield* AWS.DynamoDB.ListTagsOfResource(table);
 *
 * const response = yield* listTagsOfResource();
 * const tags = response.Tags;
 * ```
 */
export interface ListTagsOfResource extends Binding.Service<
  ListTagsOfResource,
  "AWS.DynamoDB.ListTagsOfResource",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: ListTagsOfResourceRequest,
    ) => Effect.Effect<
      DynamoDB.ListTagsOfResourceOutput,
      DynamoDB.ListTagsOfResourceError
    >
  >
> {}

export const ListTagsOfResource = Binding.Service<ListTagsOfResource>(
  "AWS.DynamoDB.ListTagsOfResource",
);
