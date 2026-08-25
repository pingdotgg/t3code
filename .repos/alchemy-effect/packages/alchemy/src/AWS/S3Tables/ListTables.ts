import type * as s3tables from "@distilled.cloud/aws/s3tables";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TableBucket } from "./TableBucket.ts";

/**
 * `ListTables` request with `tableBucketARN` injected from the bound
 * {@link TableBucket}.
 */
export interface ListTablesRequest extends Omit<
  s3tables.ListTablesRequest,
  "tableBucketARN"
> {}

/**
 * Runtime binding for the `ListTables` operation (IAM action
 * `s3tables:ListTables` on the table bucket ARN).
 *
 * Lists the tables in the bound {@link TableBucket}, optionally filtered to
 * a namespace or name prefix. Useful for compute that enumerates the
 * catalog at runtime. Provide the implementation with
 * `Effect.provide(AWS.S3Tables.ListTablesHttp)`.
 * @binding
 * @section Discovering Namespaces and Tables
 * @example List the tables in a namespace
 * ```typescript
 * const listTables = yield* AWS.S3Tables.ListTables(bucket);
 *
 * const { tables } = yield* listTables({ namespace: "events" });
 * for (const table of tables) {
 *   yield* Effect.log(`table: ${table.name}`);
 * }
 * ```
 */
export interface ListTables extends Binding.Service<
  ListTables,
  "AWS.S3Tables.ListTables",
  (
    tableBucket: TableBucket,
  ) => Effect.Effect<
    (
      request?: ListTablesRequest,
    ) => Effect.Effect<s3tables.ListTablesResponse, s3tables.ListTablesError>
  >
> {}
export const ListTables = Binding.Service<ListTables>(
  "AWS.S3Tables.ListTables",
);
