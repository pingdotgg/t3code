import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:GetTranscriptionJob` — read the status and
 * result of a batch transcription job started with
 * {@link StartTranscriptionJob}.
 *
 * Account-scoped (no resource to manage): the binding takes no arguments and
 * grants the function `transcribe:GetTranscriptionJob` (the action has no
 * resource-level IAM). Poll `TranscriptionJob.TranscriptionJobStatus` until
 * it reaches `COMPLETED` or `FAILED`.
 *
 * @binding
 * @section Polling a Transcription Job
 * @example Poll a Job to Completion
 * ```typescript
 * // init
 * const getJob = yield* AWS.Transcribe.GetTranscriptionJob();
 *
 * // runtime
 * const { TranscriptionJob } = yield* getJob({
 *   TranscriptionJobName: "my-job",
 * });
 * const status = TranscriptionJob?.TranscriptionJobStatus;
 * ```
 */
export interface GetTranscriptionJob extends Binding.Service<
  GetTranscriptionJob,
  "AWS.Transcribe.GetTranscriptionJob",
  () => Effect.Effect<
    (
      request: transcribe.GetTranscriptionJobRequest,
    ) => Effect.Effect<
      transcribe.GetTranscriptionJobResponse,
      transcribe.GetTranscriptionJobError
    >
  >
> {}
export const GetTranscriptionJob = Binding.Service<GetTranscriptionJob>(
  "AWS.Transcribe.GetTranscriptionJob",
);
