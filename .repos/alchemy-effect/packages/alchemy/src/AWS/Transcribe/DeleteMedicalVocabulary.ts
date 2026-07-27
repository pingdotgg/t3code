import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteMedicalVocabulary` — delete a medical vocabulary.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteMedicalVocabulary` on `*`.
 *
 * @binding
 * @section Medical Vocabularies
 * @example Delete a Medical Vocabulary
 * ```typescript
 * // init
 * const deleteMedicalVocabulary = yield* AWS.Transcribe.DeleteMedicalVocabulary();
 *
 * // runtime
 * yield* deleteMedicalVocabulary({ VocabularyName: "clinic-vocabulary" });
 * ```
 */
export interface DeleteMedicalVocabulary extends Binding.Service<
  DeleteMedicalVocabulary,
  "AWS.Transcribe.DeleteMedicalVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.DeleteMedicalVocabularyRequest,
    ) => Effect.Effect<
      transcribe.DeleteMedicalVocabularyResponse,
      transcribe.DeleteMedicalVocabularyError
    >
  >
> {}
export const DeleteMedicalVocabulary = Binding.Service<DeleteMedicalVocabulary>(
  "AWS.Transcribe.DeleteMedicalVocabulary",
);
