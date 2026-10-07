import type * as speech from "@distilled.cloud/gcp/speech_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { PhraseSet } from "./PhraseSet.ts";

export interface RecognizeRequest {
  /**
   * Recognize body. The bound PhraseSet is added to
   * `config.adaptation.phraseSetReferences`.
   */
  body?: speech.RecognizeRequest;
}

/**
 * Runtime binding for Speech-to-Text `speech.recognize` using a PhraseSet
 * as Adaptation.
 *
 * Bind this operation to a {@link PhraseSet} in a Function/Action init
 * phase. Provide {@link RecognizeHttp}.
 *
 * Grants `roles/speech.client` on the project because Speech-to-Text has no
 * resource-level IAM.
 *
 * ### Recognizing Speech
 * **Example:** Transcribe audio with phrase hints
 * ```typescript
 * const recognize = yield* GCP.Speech.Recognize(hints);
 * const result = yield* recognize({
 *   body: {
 *     config: { languageCode: "en-US" },
 *     audio: { uri: "gs://bucket/clip.flac" },
 *   },
 * });
 * ```
 *
 * @binding
 * @category Speech
 */
export interface Recognize extends Binding.Service<
  Recognize,
  "GCP.Speech.Recognize",
  (
    phraseSet: PhraseSet,
  ) => Effect.Effect<
    (
      request?: RecognizeRequest,
    ) => Effect.Effect<
      speech.RecognizeResponse,
      speech.RecognizeSpeechError,
      RuntimeContext
    >
  >
> {}

export const Recognize = Binding.Service<Recognize>("GCP.Speech.Recognize");
