import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:UpdateMedicalVocabulary` — replace a medical vocabulary with a new source file.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:UpdateMedicalVocabulary` on `*`.
 *
 * ### Medical Vocabularies
 * **Example:** Update a Medical Vocabulary
 * ```typescript
 * // init
 * const updateMedicalVocabulary = yield* AWS.Transcribe.UpdateMedicalVocabulary();
 *
 * // runtime
 * yield* updateMedicalVocabulary({
 *   VocabularyName: "clinic-vocabulary",
 *   LanguageCode: "en-US",
 *   VocabularyFileUri: "s3://my-bucket/vocab-v2.txt",
 * });
 * ```
 *
 * @binding
 */
export interface UpdateMedicalVocabulary extends Binding.Service<
  UpdateMedicalVocabulary,
  "AWS.Transcribe.UpdateMedicalVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.UpdateMedicalVocabularyRequest,
    ) => Effect.Effect<
      transcribe.UpdateMedicalVocabularyResponse,
      transcribe.UpdateMedicalVocabularyError
    >
  >
> {}
export const UpdateMedicalVocabulary = Binding.Service<UpdateMedicalVocabulary>(
  "AWS.Transcribe.UpdateMedicalVocabulary",
);
