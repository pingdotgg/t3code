import type * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `transcribe:GetVocabularyFilter` — read a vocabulary filter's metadata and download URI.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetVocabularyFilter` on `*`.
 *
 * ### Vocabulary Filters
 * **Example:** Get a Vocabulary Filter
 * ```typescript
 * // init
 * const getVocabularyFilter = yield* AWS.Transcribe.GetVocabularyFilter();
 *
 * // runtime
 * const { DownloadUri } = yield* getVocabularyFilter({
 *   VocabularyFilterName: "profanity-filter",
 * });
 * ```
 *
 * @binding
 */
export interface GetVocabularyFilter extends Binding.Service<
  GetVocabularyFilter,
  "AWS.Transcribe.GetVocabularyFilter",
  () => Effect.Effect<
    (
      request: transcribe.GetVocabularyFilterRequest,
    ) => Effect.Effect<transcribe.GetVocabularyFilterResponse, transcribe.GetVocabularyFilterError>
  >
> {}
export const GetVocabularyFilter = Binding.Service<GetVocabularyFilter>(
  "AWS.Transcribe.GetVocabularyFilter",
);
