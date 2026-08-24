import type * as s3tables from "@distilled.cloud/aws/s3tables";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TableBucket } from "./TableBucket.ts";

/**
 * `ListNamespaces` request with `tableBucketARN` injected from the bound
 * {@link TableBucket}.
 */
export interface ListNamespacesRequest extends Omit<
  s3tables.ListNamespacesRequest,
  "tableBucketARN"
> {}

/**
 * Runtime binding for the `ListNamespaces` operation (IAM action
 * `s3tables:ListNamespaces` on the table bucket ARN).
 *
 * Lists the namespaces in the bound {@link TableBucket} — the catalog's
 * databases. Useful for compute that discovers tables dynamically at
 * runtime. Provide the implementation with
 * `Effect.provide(AWS.S3Tables.ListNamespacesHttp)`.
 * @binding
 * @section Discovering Namespaces and Tables
 * @example List the bucket's namespaces
 * ```typescript
 * const listNamespaces = yield* AWS.S3Tables.ListNamespaces(bucket);
 *
 * const { namespaces } = yield* listNamespaces();
 * for (const ns of namespaces) {
 *   yield* Effect.log(`namespace: ${ns.namespace[0]}`);
 * }
 * ```
 */
export interface ListNamespaces extends Binding.Service<
  ListNamespaces,
  "AWS.S3Tables.ListNamespaces",
  (
    tableBucket: TableBucket,
  ) => Effect.Effect<
    (
      request?: ListNamespacesRequest,
    ) => Effect.Effect<
      s3tables.ListNamespacesResponse,
      s3tables.ListNamespacesError
    >
  >
> {}
export const ListNamespaces = Binding.Service<ListNamespaces>(
  "AWS.S3Tables.ListNamespaces",
);
