import type * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `transcribe:CreateVocabularyFilter` — create a vocabulary filter that masks, removes, or flags unwanted words in transcription output.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:CreateVocabularyFilter` on `*`.
 *
 * ### Vocabulary Filters
 * **Example:** Create a Vocabulary Filter
 * ```typescript
 * // init
 * const createVocabularyFilter = yield* AWS.Transcribe.CreateVocabularyFilter();
 *
 * // runtime
 * yield* createVocabularyFilter({
 *   VocabularyFilterName: "profanity-filter",
 *   LanguageCode: "en-US",
 *   Words: ["unwanted", "words"],
 * });
 * ```
 *
 * @binding
 */
export interface CreateVocabularyFilter extends Binding.Service<
  CreateVocabularyFilter,
  "AWS.Transcribe.CreateVocabularyFilter",
  () => Effect.Effect<
    (
      request: transcribe.CreateVocabularyFilterRequest,
    ) => Effect.Effect<
      transcribe.CreateVocabularyFilterResponse,
      transcribe.CreateVocabularyFilterError
    >
  >
> {}
export const CreateVocabularyFilter = Binding.Service<CreateVocabularyFilter>(
  "AWS.Transcribe.CreateVocabularyFilter",
);
