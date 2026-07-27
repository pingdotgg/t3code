import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:CreateVocabulary` — create a custom vocabulary that improves transcription accuracy for domain-specific terms (e.g. per-tenant vocabularies created at runtime).
 *
 * Vocabulary processing is asynchronous: the vocabulary is created in the `PENDING` state and must reach `READY` (poll with {@link GetVocabulary}) before a transcription job can reference it.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:CreateVocabulary` on `*`.
 *
 * @binding
 * @section Custom Vocabularies
 * @example Create a Custom Vocabulary
 * ```typescript
 * // init
 * const createVocabulary = yield* AWS.Transcribe.CreateVocabulary();
 *
 * // runtime
 * const { VocabularyState } = yield* createVocabulary({
 *   VocabularyName: "tenant-123-vocabulary",
 *   LanguageCode: "en-US",
 *   Phrases: ["Alchemy", "workerd"],
 * });
 * ```
 */
export interface CreateVocabulary extends Binding.Service<
  CreateVocabulary,
  "AWS.Transcribe.CreateVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.CreateVocabularyRequest,
    ) => Effect.Effect<
      transcribe.CreateVocabularyResponse,
      transcribe.CreateVocabularyError
    >
  >
> {}
export const CreateVocabulary = Binding.Service<CreateVocabulary>(
  "AWS.Transcribe.CreateVocabulary",
);
