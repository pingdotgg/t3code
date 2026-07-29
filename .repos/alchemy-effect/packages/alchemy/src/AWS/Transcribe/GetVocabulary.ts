import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:GetVocabulary` — read a custom vocabulary's processing state and download URI.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetVocabulary` on `*`.
 *
 * @binding
 * @section Custom Vocabularies
 * @example Poll a Custom Vocabulary
 * ```typescript
 * // init
 * const getVocabulary = yield* AWS.Transcribe.GetVocabulary();
 *
 * // runtime
 * const { VocabularyState } = yield* getVocabulary({
 *   VocabularyName: "tenant-123-vocabulary",
 * });
 * ```
 */
export interface GetVocabulary extends Binding.Service<
  GetVocabulary,
  "AWS.Transcribe.GetVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.GetVocabularyRequest,
    ) => Effect.Effect<
      transcribe.GetVocabularyResponse,
      transcribe.GetVocabularyError
    >
  >
> {}
export const GetVocabulary = Binding.Service<GetVocabulary>(
  "AWS.Transcribe.GetVocabulary",
);
