import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteVocabularyFilter` — delete a vocabulary filter.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteVocabularyFilter` on `*`.
 *
 * @binding
 * @section Vocabulary Filters
 * @example Delete a Vocabulary Filter
 * ```typescript
 * // init
 * const deleteVocabularyFilter = yield* AWS.Transcribe.DeleteVocabularyFilter();
 *
 * // runtime
 * yield* deleteVocabularyFilter({ VocabularyFilterName: "profanity-filter" });
 * ```
 */
export interface DeleteVocabularyFilter extends Binding.Service<
  DeleteVocabularyFilter,
  "AWS.Transcribe.DeleteVocabularyFilter",
  () => Effect.Effect<
    (
      request: transcribe.DeleteVocabularyFilterRequest,
    ) => Effect.Effect<
      transcribe.DeleteVocabularyFilterResponse,
      transcribe.DeleteVocabularyFilterError
    >
  >
> {}
export const DeleteVocabularyFilter = Binding.Service<DeleteVocabularyFilter>(
  "AWS.Transcribe.DeleteVocabularyFilter",
);
