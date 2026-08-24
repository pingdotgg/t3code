import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteMedicalTranscriptionJob` — delete a medical transcription job.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteMedicalTranscriptionJob` on `*`.
 *
 * @binding
 * @section Medical Transcription Jobs
 * @example Delete a Medical Transcription Job
 * ```typescript
 * // init
 * const deleteMedicalTranscriptionJob = yield* AWS.Transcribe.DeleteMedicalTranscriptionJob();
 *
 * // runtime
 * yield* deleteMedicalTranscriptionJob({ MedicalTranscriptionJobName: "my-medical-job" });
 * ```
 */
export interface DeleteMedicalTranscriptionJob extends Binding.Service<
  DeleteMedicalTranscriptionJob,
  "AWS.Transcribe.DeleteMedicalTranscriptionJob",
  () => Effect.Effect<
    (
      request: transcribe.DeleteMedicalTranscriptionJobRequest,
    ) => Effect.Effect<
      transcribe.DeleteMedicalTranscriptionJobResponse,
      transcribe.DeleteMedicalTranscriptionJobError
    >
  >
> {}
export const DeleteMedicalTranscriptionJob =
  Binding.Service<DeleteMedicalTranscriptionJob>(
    "AWS.Transcribe.DeleteMedicalTranscriptionJob",
  );
