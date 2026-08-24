import type * as polly from "@distilled.cloud/aws/polly";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `polly:StartSpeechSynthesisTask` — start an
 * asynchronous synthesis task that writes the audio (or speech marks) to an
 * S3 bucket, for texts too long for the synchronous `SynthesizeSpeech`.
 *
 * The binding grants `polly:StartSpeechSynthesisTask`. Polly writes the
 * output with the **caller's** credentials, so the function also needs
 * `s3:PutObject` on the output bucket — compose with
 * `AWS.S3.PutObject(bucket)`. Provide the implementation with
 * `Effect.provide(AWS.Polly.StartSpeechSynthesisTaskHttp)`.
 *
 * @binding
 * @section Asynchronous Synthesis
 * @example Start a synthesis task writing MP3 to S3
 * ```typescript
 * // init — the S3 PutObject binding grants Polly's output write
 * yield* AWS.S3.PutObject(bucket);
 * const startSpeechSynthesisTask = yield* AWS.Polly.StartSpeechSynthesisTask();
 *
 * // runtime
 * const started = yield* startSpeechSynthesisTask({
 *   OutputFormat: "mp3",
 *   OutputS3BucketName: "my-audio-bucket",
 *   VoiceId: "Joanna",
 *   Text: longArticleText,
 * });
 * const taskId = started.SynthesisTask?.TaskId;
 * ```
 */
export interface StartSpeechSynthesisTask extends Binding.Service<
  StartSpeechSynthesisTask,
  "AWS.Polly.StartSpeechSynthesisTask",
  () => Effect.Effect<
    (
      request: polly.StartSpeechSynthesisTaskInput,
    ) => Effect.Effect<
      polly.StartSpeechSynthesisTaskOutput,
      polly.StartSpeechSynthesisTaskError
    >
  >
> {}
export const StartSpeechSynthesisTask =
  Binding.Service<StartSpeechSynthesisTask>(
    "AWS.Polly.StartSpeechSynthesisTask",
  );
