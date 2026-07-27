import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListTablesRequest extends DynamoDB.ListTablesInput {}

/**
 * Runtime binding for `dynamodb:ListTables`.
 *
 * An account-level binding — call it with no arguments to get a callable that
 * lists table names in the region. Provide the `ListTablesHttp` layer on the
 * Function to satisfy the binding.
 * @binding
 * @section Table Metadata
 * @example List Tables in the Region
 * ```typescript
 * const listTables = yield* AWS.DynamoDB.ListTables();
 *
 * const response = yield* listTables();
 * const tableNames = response.TableNames;
 * ```
 */
export interface ListTables extends Binding.Service<
  ListTables,
  "AWS.DynamoDB.ListTables",
  () => Effect.Effect<
    (
      request?: ListTablesRequest,
    ) => Effect.Effect<DynamoDB.ListTablesOutput, DynamoDB.ListTablesError>
  >
> {}

export const ListTables = Binding.Service<ListTables>(
  "AWS.DynamoDB.ListTables",
);
