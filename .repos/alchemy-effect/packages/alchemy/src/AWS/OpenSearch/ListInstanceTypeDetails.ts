import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListInstanceTypeDetails` operation (IAM action
 * `es:ListInstanceTypeDetails`).
 *
 * Lists the instance types (and their capabilities — encryption, warm storage, app logs) supported by an engine version, e.g. to validate a resize before applying it. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.ListInstanceTypeDetailsHttp)`.
 * @binding
 * @section Engine Catalog
 * @example List Instance Types for a Version
 * ```typescript
 * const listInstanceTypeDetails = yield* OpenSearch.ListInstanceTypeDetails();
 *
 * const result = yield* listInstanceTypeDetails({
 *   EngineVersion: "OpenSearch_2.19",
 * });
 * // result.InstanceTypeDetails → supported instance types
 * ```
 */
export interface ListInstanceTypeDetails extends Binding.Service<
  ListInstanceTypeDetails,
  "AWS.OpenSearch.ListInstanceTypeDetails",
  () => Effect.Effect<
    (
      request: opensearch.ListInstanceTypeDetailsRequest,
    ) => Effect.Effect<
      opensearch.ListInstanceTypeDetailsResponse,
      opensearch.ListInstanceTypeDetailsError
    >
  >
> {}
export const ListInstanceTypeDetails = Binding.Service<ListInstanceTypeDetails>(
  "AWS.OpenSearch.ListInstanceTypeDetails",
);
