import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:UpdateVocabularyFilter` — replace a vocabulary filter's word list.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:UpdateVocabularyFilter` on `*`.
 *
 * @binding
 * @section Vocabulary Filters
 * @example Update a Vocabulary Filter
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
