import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `polly:StartSpeechSynthesisStream` — bidirectional
 * streaming synthesis: send text incrementally as `TextEvent`s on the input
 * `ActionStream` and receive `AudioEvent` chunks on the output `EventStream`
 * as they become available.
 *
 * The binding takes no arguments and grants the function
 * `polly:StartSpeechSynthesisStream`. Provide the implementation with
 * `Effect.provide(AWS.Polly.StartSpeechSynthesisStreamHttp)`.
 *
 * NOTE: the distilled HTTP transport does not yet support bidirectional
 * (input) event-stream request bodies — a live call currently hangs waiting
 * for response headers (probed 2026-07; same transport gap leaves
 * transcribe-streaming and lex StartConversation unbound). Prefer
 * `SynthesizeSpeech` (request-response) until distilled core ships
 * event-stream request support.
 *
 * @binding
 * @section Streaming Synthesis
 * @example Stream text in, collect audio out
 * ```typescript
 * // init
 * const startSpeechSynthesisStream =
 *   yield* AWS.Polly.StartSpeechSynthesisStream();
 *
 * // runtime
 * const result = yield* startSpeechSynthesisStream({
 *   Engine: "generative",
 *   OutputFormat: "mp3",
 *   VoiceId: "Matthew",
 *   ActionStream: Stream.make(
 *     { TextEvent: { Text: "Hello from Alchemy." } },
 *     { CloseStreamEvent: {} },
 *   ),
 * });
 * const events = yield* Stream.runCollect(result.EventStream!);
 * const audioBytes = Array.from(events)
 *   .flatMap((event) => (event.AudioEvent?.AudioChunk ? [event.AudioEvent.AudioChunk] : []))
 *   .reduce((total, chunk) => total + chunk.length, 0);
 * ```
 */
export interface StartSpeechSynthesisStream extends Binding.Service<
  StartSpeechSynthesisStream,
  "AWS.Polly.StartSpeechSynthesisStream",
  () => Effect.Effect<
    (
      request: polly.StartSpeechSynthesisStreamInput,
    ) => Effect.Effect<
      polly.StartSpeechSynthesisStreamOutput,
      polly.StartSpeechSynthesisStreamError
    >
  >
> {}
export const StartSpeechSynthesisStream =
  Binding.Service<StartSpeechSynthesisStream>(
    "AWS.Polly.StartSpeechSynthesisStream",
  );
