import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `polly:SynthesizeSpeech` — synthesize UTF-8 plain
 * text or SSML into a stream of audio bytes.
 *
 * Polly is a pure pay-per-call service with no resource to manage: the
 * binding takes no arguments and grants the function
 * `polly:SynthesizeSpeech`. The response `AudioStream` is a byte `Stream`
 * of the encoded audio (raw distilled types, no marshalling). Provide the
 * implementation with `Effect.provide(AWS.Polly.SynthesizeSpeechHttp)`.
 *
 * @binding
 * @section Synthesizing Speech
 * @example Synthesize Text to MP3 Bytes
 * ```typescript
 * // init
 * const synthesizeSpeech = yield* AWS.Polly.SynthesizeSpeech();
 *
 * // runtime — AudioStream is a byte Stream of the encoded audio
 * const result = yield* synthesizeSpeech({
 *   Engine: "neural",
 *   OutputFormat: "mp3",
 *   VoiceId: "Joanna",
 *   Text: "Hello from Alchemy.",
 * });
 * const chunks = yield* Stream.runCollect(result.AudioStream!);
 * ```
 */
export interface SynthesizeSpeech extends Binding.Service<
  SynthesizeSpeech,
  "AWS.Polly.SynthesizeSpeech",
  () => Effect.Effect<
    (
      request: polly.SynthesizeSpeechInput,
    ) => Effect.Effect<
      polly.SynthesizeSpeechOutput,
      polly.SynthesizeSpeechError
    >
  >
> {}
export const SynthesizeSpeech = Binding.Service<SynthesizeSpeech>(
  "AWS.Polly.SynthesizeSpeech",
);
