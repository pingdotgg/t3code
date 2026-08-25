import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:UpdateVocabulary` — replace a custom vocabulary's phrases (the vocabulary re-enters `PENDING` while it reprocesses).
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:UpdateVocabulary` on `*`.
 *
 * @binding
 * @section Custom Vocabularies
 * @example Update a Custom Vocabulary
 * ```typescript
 * // init
 * const updateVocabulary = yield* AWS.Transcribe.UpdateVocabulary();
 *
 * // runtime
 * yield* updateVocabulary({
 *   VocabularyName: "tenant-123-vocabulary",
 *   LanguageCode: "en-US",
 *   Phrases: ["Alchemy", "workerd", "distilled"],
 * });
 * ```
 */
export interface UpdateVocabulary extends Binding.Service<
  UpdateVocabulary,
  "AWS.Transcribe.UpdateVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.UpdateVocabularyRequest,
    ) => Effect.Effect<
      transcribe.UpdateVocabularyResponse,
      transcribe.UpdateVocabularyError
    >
  >
> {}
export const UpdateVocabulary = Binding.Service<UpdateVocabulary>(
  "AWS.Transcribe.UpdateVocabulary",
);
