import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DescribeTimeToLiveRequest extends Omit<
  DynamoDB.DescribeTimeToLiveInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:DescribeTimeToLive`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that reads the table's TTL configuration. Provide the
 * `DescribeTimeToLiveHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Time to Live
 * @example Read the TTL Configuration
 * ```typescript
 * const describeTimeToLive = yield* AWS.DynamoDB.DescribeTimeToLive(table);
 *
 * const response = yield* describeTimeToLive();
 * const ttlStatus = response.TimeToLiveDescription?.TimeToLiveStatus;
 * ```
 */
export interface DescribeTimeToLive extends Binding.Service<
  DescribeTimeToLive,
  "AWS.DynamoDB.DescribeTimeToLive",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: DescribeTimeToLiveRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeTimeToLiveOutput,
      DynamoDB.DescribeTimeToLiveError
    >
  >
> {}
export const DescribeTimeToLive = Binding.Service<DescribeTimeToLive>(
  "AWS.DynamoDB.DescribeTimeToLive",
);
