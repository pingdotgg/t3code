import type * as RE2 from "@distilled.cloud/aws/resource-explorer-2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { View } from "./View.ts";

export interface SearchRequest extends Omit<RE2.SearchInput, "ViewArn"> {}

/**
 * Runtime binding for `resource-explorer-2:Search`.
 *
 * Bind this operation to a `View` inside a function runtime to get a
 * callable that automatically injects the view's ARN. Results are the
 * intersection of the `QueryString` and the view's filter. Provide the
 * implementation with `Effect.provide(AWS.ResourceExplorer.SearchHttp)`.
 * @binding
 * @section Searching Resources
 * @example Search for S3 buckets
 * ```typescript
 * const search = yield* AWS.ResourceExplorer.Search(view);
 *
 * const results = yield* search({
 *   QueryString: "service:s3",
 *   MaxResults: 50,
 * });
 * // results.Resources, results.Count?.TotalResources
 * ```
 */
export interface Search extends Binding.Service<
  Search,
  "AWS.ResourceExplorer.Search",
  <V extends View>(
    view: V,
  ) => Effect.Effect<
    (request: SearchRequest) => Effect.Effect<RE2.SearchOutput, RE2.SearchError>
  >
> {}
export const Search = Binding.Service<Search>("AWS.ResourceExplorer.Search");
