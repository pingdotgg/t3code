import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:StartTranscriptionJob` — kick off an
 * asynchronous batch transcription of an audio/video file stored in S3.
 *
 * Transcribe batch jobs are account-scoped (no resource to manage): the
 * binding takes no arguments and grants the function
 * `transcribe:StartTranscriptionJob` (the action has no resource-level IAM).
 * The input `Media.MediaFileUri` and the output bucket are S3 locations —
 * grant the function S3 access to those buckets separately. Poll the job to
 * completion with {@link GetTranscriptionJob}.
 *
 * @binding
 * @section Starting a Transcription Job
 * @example Transcribe an S3 Audio File
 * ```typescript
 * // init
 * const startJob = yield* AWS.Transcribe.StartTranscriptionJob();
 *
 * // runtime
 * const { TranscriptionJob } = yield* startJob({
 *   TranscriptionJobName: "my-job",
 *   LanguageCode: "en-US",
 *   Media: { MediaFileUri: "s3://my-bucket/audio/sample.wav" },
 *   OutputBucketName: "my-output-bucket",
 * });
 * ```
 */
export interface StartTranscriptionJob extends Binding.Service<
  StartTranscriptionJob,
  "AWS.Transcribe.StartTranscriptionJob",
  () => Effect.Effect<
    (
      request: transcribe.StartTranscriptionJobRequest,
    ) => Effect.Effect<
      transcribe.StartTranscriptionJobResponse,
      transcribe.StartTranscriptionJobError
    >
  >
> {}
export const StartTranscriptionJob = Binding.Service<StartTranscriptionJob>(
  "AWS.Transcribe.StartTranscriptionJob",
);
