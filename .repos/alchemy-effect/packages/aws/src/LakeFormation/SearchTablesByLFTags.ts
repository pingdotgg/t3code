import type * as lf from "@distilled.cloud/aws/lakeformation";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Request for {@link SearchTablesByLFTags}.
 */
export interface SearchTablesByLFTagsRequest extends lf.SearchTablesByLFTagsRequest {}

/**
 * Runtime binding for `lakeformation:SearchTablesByLFTags`.
 *
 * Finds Glue tables whose LF-tags match an expression — tag-driven data
 * discovery at runtime. Provide the implementation with
 * `Effect.provide(AWS.LakeFormation.SearchTablesByLFTagsHttp)`.
 * ### Searching by LF-Tags
 * **Example:** Find Tables Tagged pii
 * ```typescript
 * // init — account-level binding takes no resource
 * const searchTables = yield* AWS.LakeFormation.SearchTablesByLFTags();
 *
 * // runtime
 * const { TableList } = yield* searchTables({
 *   Expression: [{ TagKey: "classification", TagValues: ["pii"] }],
 * });
 * ```
 *
 * @binding
 */
export interface SearchTablesByLFTags extends Binding.Service<
  SearchTablesByLFTags,
  "AWS.LakeFormation.SearchTablesByLFTags",
  () => Effect.Effect<
    (
      request: SearchTablesByLFTagsRequest,
    ) => Effect.Effect<lf.SearchTablesByLFTagsResponse, lf.SearchTablesByLFTagsError>
  >
> {}

export const SearchTablesByLFTags = Binding.Service<SearchTablesByLFTags>(
  "AWS.LakeFormation.SearchTablesByLFTags",
);
