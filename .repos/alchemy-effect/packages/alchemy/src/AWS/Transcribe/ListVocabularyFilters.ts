import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListVocabularyFilters` — list the vocabulary filters in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListVocabularyFilters` on `*`.
 *
 * @binding
 * @section Vocabulary Filters
 * @example List Vocabulary Filters
 * ```typescript
 * // init
 * const listVocabularyFilters = yield* AWS.Transcribe.ListVocabularyFilters();
 *
 * // runtime
 * const { VocabularyFilters } = yield* listVocabularyFilters({ MaxResults: 10 });
 * ```
 */
export interface ListVocabularyFilters extends Binding.Service<
  ListVocabularyFilters,
  "AWS.Transcribe.ListVocabularyFilters",
  () => Effect.Effect<
    (
      request?: transcribe.ListVocabularyFiltersRequest,
    ) => Effect.Effect<
      transcribe.ListVocabularyFiltersResponse,
      transcribe.ListVocabularyFiltersError
    >
  >
> {}
export const ListVocabularyFilters = Binding.Service<ListVocabularyFilters>(
  "AWS.Transcribe.ListVocabularyFilters",
);
