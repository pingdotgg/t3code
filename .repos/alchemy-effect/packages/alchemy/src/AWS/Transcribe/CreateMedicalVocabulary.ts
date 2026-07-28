import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:CreateMedicalVocabulary` — create a custom medical vocabulary from a text file in S3 (asynchronous: created `PENDING`, poll to `READY` with {@link GetMedicalVocabulary}).
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:CreateMedicalVocabulary` on `*`.
 *
 * @binding
 * @section Medical Vocabularies
 * @example Create a Medical Vocabulary
 * ```typescript
 * // init
 * const createMedicalVocabulary = yield* AWS.Transcribe.CreateMedicalVocabulary();
 *
 * // runtime
 * yield* createMedicalVocabulary({
 *   VocabularyName: "clinic-vocabulary",
 *   LanguageCode: "en-US",
 *   VocabularyFileUri: "s3://my-bucket/vocab.txt",
 * });
 * ```
 */
export interface CreateMedicalVocabulary extends Binding.Service<
  CreateMedicalVocabulary,
  "AWS.Transcribe.CreateMedicalVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.CreateMedicalVocabularyRequest,
    ) => Effect.Effect<
      transcribe.CreateMedicalVocabularyResponse,
      transcribe.CreateMedicalVocabularyError
    >
  >
> {}
export const CreateMedicalVocabulary = Binding.Service<CreateMedicalVocabulary>(
  "AWS.Transcribe.CreateMedicalVocabulary",
);
