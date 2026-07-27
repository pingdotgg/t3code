import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * Runtime binding for the `ClearQuerySuggestions` operation (IAM action
 * `kendra:ClearQuerySuggestions`), scoped to one {@link Index}.
 *
 * Clears existing query suggestions for the index. Suggestions rebuild
 * from new query traffic (which can take up to 24 hours).
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.ClearQuerySuggestionsHttp)`.
 *
 * @binding
 * @section Query Suggestions
 * @example Reset Suggestions
 * ```typescript
 * const clearSuggestions = yield* AWS.Kendra.ClearQuerySuggestions(index);
 *
 * yield* clearSuggestions();
 * ```
 */
export interface ClearQuerySuggestions extends Binding.Service<
  ClearQuerySuggestions,
  "AWS.Kendra.ClearQuerySuggestions",
  (
    index: Index,
  ) => Effect.Effect<
    () => Effect.Effect<
      kendra.ClearQuerySuggestionsResponse,
      kendra.ClearQuerySuggestionsError
    >
  >
> {}
export const ClearQuerySuggestions = Binding.Service<ClearQuerySuggestions>(
  "AWS.Kendra.ClearQuerySuggestions",
);
