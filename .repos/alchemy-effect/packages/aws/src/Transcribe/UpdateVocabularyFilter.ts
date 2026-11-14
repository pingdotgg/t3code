import type * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `transcribe:UpdateVocabularyFilter` — replace a vocabulary filter's word list.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:UpdateVocabularyFilter` on `*`.
 *
 * ### Vocabulary Filters
 * **Example:** Update a Vocabulary Filter
 * ```typescript
 * // init
 * const updateVocabularyFilter = yield* AWS.Transcribe.UpdateVocabularyFilter();
 *
 * // runtime
 * yield* updateVocabularyFilter({
 *   VocabularyFilterName: "profanity-filter",
 *   Words: ["unwanted", "words", "more"],
 * });
 * ```
 *
 * @binding
 */
export interface UpdateVocabularyFilter extends Binding.Service<
  UpdateVocabularyFilter,
  "AWS.Transcribe.UpdateVocabularyFilter",
  () => Effect.Effect<
    (
      request: transcribe.UpdateVocabularyFilterRequest,
    ) => Effect.Effect<
      transcribe.UpdateVocabularyFilterResponse,
      transcribe.UpdateVocabularyFilterError
    >
  >
> {}
export const UpdateVocabularyFilter = Binding.Service<UpdateVocabularyFilter>(
  "AWS.Transcribe.UpdateVocabularyFilter",
);
