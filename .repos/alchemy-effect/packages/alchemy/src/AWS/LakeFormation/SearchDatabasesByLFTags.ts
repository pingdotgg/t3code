import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link SearchDatabasesByLFTags}.
 */
export interface SearchDatabasesByLFTagsRequest
  extends lf.SearchDatabasesByLFTagsRequest {}

/**
 * Runtime binding for `lakeformation:SearchDatabasesByLFTags`.
 *
 * Finds Glue databases whose LF-tags match an expression — tag-driven data
 * discovery at runtime. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.SearchDatabasesByLFTagsHttp)`.
 * @binding
 * @section Searching by LF-Tags
 * @example Find Databases Tagged prod
 * ```typescript
 * // init — account-level binding takes no resource
 * const searchDatabases = yield* AWS.LakeFormation.SearchDatabasesByLFTags();
 *
 * // runtime
 * const { DatabaseList } = yield* searchDatabases({
 *   Expression: [{ TagKey: "environment", TagValues: ["prod"] }],
 * });
 * ```
 */
export interface SearchDatabasesByLFTags extends Binding.Service<
  SearchDatabasesByLFTags,
  "AWS.LakeFormation.SearchDatabasesByLFTags",
  () => Effect.Effect<
    (
      request: SearchDatabasesByLFTagsRequest,
    ) => Effect.Effect<
      lf.SearchDatabasesByLFTagsResponse,
      lf.SearchDatabasesByLFTagsError
    >
  >
> {}

export const SearchDatabasesByLFTags = Binding.Service<SearchDatabasesByLFTags>(
  "AWS.LakeFormation.SearchDatabasesByLFTags",
);
