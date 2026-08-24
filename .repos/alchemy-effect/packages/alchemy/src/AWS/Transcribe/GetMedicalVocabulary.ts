import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:GetMedicalVocabulary` — read a medical vocabulary's processing state and download URI.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetMedicalVocabulary` on `*`.
 *
 * @binding
 * @section Medical Vocabularies
 * @example Poll a Medical Vocabulary
 * ```typescript
 * // init
 * const getMedicalVocabulary = yield* AWS.Transcribe.GetMedicalVocabulary();
 *
 * // runtime
 * const { VocabularyState } = yield* getMedicalVocabulary({
 *   VocabularyName: "clinic-vocabulary",
 * });
 * ```
 */
export interface GetMedicalVocabulary extends Binding.Service<
  GetMedicalVocabulary,
  "AWS.Transcribe.GetMedicalVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.GetMedicalVocabularyRequest,
    ) => Effect.Effect<
      transcribe.GetMedicalVocabularyResponse,
      transcribe.GetMedicalVocabularyError
    >
  >
> {}
export const GetMedicalVocabulary = Binding.Service<GetMedicalVocabulary>(
  "AWS.Transcribe.GetMedicalVocabulary",
);
