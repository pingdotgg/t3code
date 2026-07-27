import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ListExportsRequest extends Omit<
  DynamoDB.ListExportsInput,
  "TableArn"
> {}

/**
 * Runtime binding for `dynamodb:ListExports`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that lists the bound table's S3 exports, automatically injecting the table
 * ARN. Provide the `ListExportsHttp` layer on the Function to satisfy the
 * binding.
 * @binding
 * @section Exporting to S3
 * @example List the Bound Table's Exports
 * ```typescript
 * const listExports = yield* AWS.DynamoDB.ListExports(table);
 *
 * const response = yield* listExports();
 * const exports = response.ExportSummaries;
 * ```
 */
export interface ListExports extends Binding.Service<
  ListExports,
  "AWS.DynamoDB.ListExports",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: ListExportsRequest,
    ) => Effect.Effect<DynamoDB.ListExportsOutput, DynamoDB.ListExportsError>
  >
> {}
export const ListExports = Binding.Service<ListExports>(
  "AWS.DynamoDB.ListExports",
);
