import type * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `transcribe:GetVocabulary` — read a custom vocabulary's processing state and download URI.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetVocabulary` on `*`.
 *
 * ### Custom Vocabularies
 * **Example:** Poll a Custom Vocabulary
 * ```typescript
 * // init
 * const getVocabulary = yield* AWS.Transcribe.GetVocabulary();
 *
 * // runtime
 * const { VocabularyState } = yield* getVocabulary({
 *   VocabularyName: "tenant-123-vocabulary",
 * });
 * ```
 *
 * @binding
 */
export interface GetVocabulary extends Binding.Service<
  GetVocabulary,
  "AWS.Transcribe.GetVocabulary",
  () => Effect.Effect<
    (
      request: transcribe.GetVocabularyRequest,
    ) => Effect.Effect<transcribe.GetVocabularyResponse, transcribe.GetVocabularyError>
  >
> {}
export const GetVocabulary = Binding.Service<GetVocabulary>("AWS.Transcribe.GetVocabulary");
