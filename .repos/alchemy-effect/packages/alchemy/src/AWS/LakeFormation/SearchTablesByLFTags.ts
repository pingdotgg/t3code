import type * as lf from "@distilled.cloud/aws/lakeformation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link SearchTablesByLFTags}.
 */
export interface SearchTablesByLFTagsRequest
  extends lf.SearchTablesByLFTagsRequest {}

/**
 * Runtime binding for `lakeformation:SearchTablesByLFTags`.
 *
 * Finds Glue tables whose LF-tags match an expression — tag-driven data
 * discovery at runtime. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.SearchTablesByLFTagsHttp)`.
 * @binding
 * @section Searching by LF-Tags
 * @example Find Tables Tagged pii
 * ```typescript
 * // init — account-level binding takes no resource
 * const searchTables = yield* AWS.LakeFormation.SearchTablesByLFTags();
 *
 * // runtime
 * const { TableList } = yield* searchTables({
 *   Expression: [{ TagKey: "classification", TagValues: ["pii"] }],
 * });
 * ```
 */
export interface SearchTablesByLFTags extends Binding.Service<
  SearchTablesByLFTags,
  "AWS.LakeFormation.SearchTablesByLFTags",
  () => Effect.Effect<
    (
      request: SearchTablesByLFTagsRequest,
    ) => Effect.Effect<
      lf.SearchTablesByLFTagsResponse,
      lf.SearchTablesByLFTagsError
    >
  >
> {}

export const SearchTablesByLFTags = Binding.Service<SearchTablesByLFTags>(
  "AWS.LakeFormation.SearchTablesByLFTags",
);
