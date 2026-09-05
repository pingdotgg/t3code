import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DescribeTableRequest extends Omit<
  DynamoDB.DescribeTableInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:DescribeTable`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that reads the table's metadata (key schema, indexes, status, throughput).
 * Provide the `DescribeTableHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Table Metadata
 * @example Describe the Bound Table
 * ```typescript
 * const describeTable = yield* AWS.DynamoDB.DescribeTable(table);
 *
 * const response = yield* describeTable();
 * const status = response.Table?.TableStatus;
 * ```
 */
export interface DescribeTable extends Binding.Service<
  DescribeTable,
  "AWS.DynamoDB.DescribeTable",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: DescribeTableRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeTableOutput,
      DynamoDB.DescribeTableError
    >
  >
> {}

export const DescribeTable = Binding.Service<DescribeTable>(
  "AWS.DynamoDB.DescribeTable",
);
