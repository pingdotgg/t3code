import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteTranscriptionJob` — delete a batch transcription job and its transcript from the service-managed output location.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteTranscriptionJob` on `*`.
 *
 * @binding
 * @section Batch Transcription Jobs
 * @example Delete a Transcription Job
 * ```typescript
 * // init
 * const deleteTranscriptionJob = yield* AWS.Transcribe.DeleteTranscriptionJob();
 *
 * // runtime
 * yield* deleteTranscriptionJob({ TranscriptionJobName: "my-job" });
 * ```
 */
export interface DeleteTranscriptionJob extends Binding.Service<
  DeleteTranscriptionJob,
  "AWS.Transcribe.DeleteTranscriptionJob",
  () => Effect.Effect<
    (
      request: transcribe.DeleteTranscriptionJobRequest,
    ) => Effect.Effect<
      transcribe.DeleteTranscriptionJobResponse,
      transcribe.DeleteTranscriptionJobError
    >
  >
> {}
export const DeleteTranscriptionJob = Binding.Service<DeleteTranscriptionJob>(
  "AWS.Transcribe.DeleteTranscriptionJob",
);
