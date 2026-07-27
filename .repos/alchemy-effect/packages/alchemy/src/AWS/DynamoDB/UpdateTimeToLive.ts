import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface UpdateTimeToLiveRequest extends Omit<
  DynamoDB.UpdateTimeToLiveInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:UpdateTimeToLive`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that enables or disables TTL expiry on an attribute. Provide the
 * `UpdateTimeToLiveHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Time to Live
 * @example Enable TTL on an Attribute
 * ```typescript
 * const updateTimeToLive = yield* AWS.DynamoDB.UpdateTimeToLive(table);
 *
 * yield* updateTimeToLive({
 *   TimeToLiveSpecification: {
 *     AttributeName: "expiresAt",
 *     Enabled: true,
 *   },
 * });
 * ```
 */
export interface UpdateTimeToLive extends Binding.Service<
  UpdateTimeToLive,
  "AWS.DynamoDB.UpdateTimeToLive",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: UpdateTimeToLiveRequest,
    ) => Effect.Effect<
      DynamoDB.UpdateTimeToLiveOutput,
      DynamoDB.UpdateTimeToLiveError
    >
  >
> {}
export const UpdateTimeToLive = Binding.Service<UpdateTimeToLive>(
  "AWS.DynamoDB.UpdateTimeToLive",
);
