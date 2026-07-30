import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `GetQuerySuggestions` request with `IndexId` injected from the bound index.
 */
export interface GetQuerySuggestionsRequest extends Omit<
  kendra.GetQuerySuggestionsRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `GetQuerySuggestions` operation (IAM action
 * `kendra:GetQuerySuggestions`), scoped to one {@link Index}.
 *
 * Fetches typeahead query suggestions for a partial query string, based
 * on the index's query history and/or document fields.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.GetQuerySuggestionsHttp)`.
 *
 * @binding
 * @section Query Suggestions
 * @example Typeahead Suggestions
 * ```typescript
 * const suggest = yield* AWS.Kendra.GetQuerySuggestions(index);
 *
 * const { Suggestions } = yield* suggest({ QueryText: "how to conf" });
 * ```
 */
export interface GetQuerySuggestions extends Binding.Service<
  GetQuerySuggestions,
  "AWS.Kendra.GetQuerySuggestions",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: GetQuerySuggestionsRequest,
    ) => Effect.Effect<
      kendra.GetQuerySuggestionsResponse,
      kendra.GetQuerySuggestionsError
    >
  >
> {}
export const GetQuerySuggestions = Binding.Service<GetQuerySuggestions>(
  "AWS.Kendra.GetQuerySuggestions",
);
