import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetCompatibleVersions` operation (IAM action
 * `es:GetCompatibleVersions`).
 *
 * Maps engine versions to the versions they can be upgraded to — for one domain (pass `DomainName`) or for every supported version. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.GetCompatibleVersionsHttp)`.
 * @binding
 * @section Engine Upgrades
 * @example Find Valid Upgrade Targets
 * ```typescript
 * const getCompatibleVersions = yield* OpenSearch.GetCompatibleVersions();
 *
 * const result = yield* getCompatibleVersions({ DomainName: name });
 * // result.CompatibleVersions?.[0]?.TargetVersions → upgrade targets
 * ```
 */
export interface GetCompatibleVersions extends Binding.Service<
  GetCompatibleVersions,
  "AWS.OpenSearch.GetCompatibleVersions",
  () => Effect.Effect<
    (
      request?: opensearch.GetCompatibleVersionsRequest,
    ) => Effect.Effect<
      opensearch.GetCompatibleVersionsResponse,
      opensearch.GetCompatibleVersionsError
    >
  >
> {}
export const GetCompatibleVersions = Binding.Service<GetCompatibleVersions>(
  "AWS.OpenSearch.GetCompatibleVersions",
);
