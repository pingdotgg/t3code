import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteVocabulary` — delete a custom vocabulary.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteVocabulary` on `*`.
 *
 * @binding
 * @section Custom Vocabularies
 * @example Delete a Custom Vocabulary
 * ```typescript
 * // init
 * const deleteVocabulary = yield* AWS.Transcribe.DeleteVocabulary();
 *
 * // runtime
 * yield* deleteVocabulary({ VocabularyName: "tenant-123-vocabulary" });
 * ```
 */
export interface DeleteVocabulary extends Binding.Service<
  DeleteVocabulary,
  "AWS.Transcribe.DeleteVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.DeleteVocabularyRequest,
    ) => Effect.Effect<
      transcribe.DeleteVocabularyResponse,
      transcribe.DeleteVocabularyError
    >
  >
> {}
export const DeleteVocabulary = Binding.Service<DeleteVocabulary>(
  "AWS.Transcribe.DeleteVocabulary",
);
