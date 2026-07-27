import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListVersions` operation (IAM action
 * `es:ListVersions`).
 *
 * Lists every OpenSearch and Elasticsearch version the service supports — e.g. to validate an upgrade target before calling the upgrade API. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.ListVersionsHttp)`.
 * @binding
 * @section Engine Catalog
 * @example List Supported Engine Versions
 * ```typescript
 * const listVersions = yield* OpenSearch.ListVersions();
 *
 * const result = yield* listVersions();
 * // result.Versions → ["OpenSearch_2.19", …]
 * ```
 */
export interface ListVersions extends Binding.Service<
  ListVersions,
  "AWS.OpenSearch.ListVersions",
  () => Effect.Effect<
    (
      request?: opensearch.ListVersionsRequest,
    ) => Effect.Effect<
      opensearch.ListVersionsResponse,
      opensearch.ListVersionsError
    >
  >
> {}
export const ListVersions = Binding.Service<ListVersions>(
  "AWS.OpenSearch.ListVersions",
);
