import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:GetMedicalTranscriptionJob` — read a medical transcription job's status and transcript location.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetMedicalTranscriptionJob` on `*`.
 *
 * @binding
 * @section Medical Transcription Jobs
 * @example Poll a Medical Transcription Job
 * ```typescript
 * // init
 * const getMedicalTranscriptionJob = yield* AWS.Transcribe.GetMedicalTranscriptionJob();
 *
 * // runtime
 * const { MedicalTranscriptionJob } = yield* getMedicalTranscriptionJob({
 *   MedicalTranscriptionJobName: "my-medical-job",
 * });
 * ```
 */
export interface GetMedicalTranscriptionJob extends Binding.Service<
  GetMedicalTranscriptionJob,
  "AWS.Transcribe.GetMedicalTranscriptionJob",
  () => Effect.Effect<
    (
      request: transcribe.GetMedicalTranscriptionJobRequest,
    ) => Effect.Effect<
      transcribe.GetMedicalTranscriptionJobResponse,
      transcribe.GetMedicalTranscriptionJobError
    >
  >
> {}
export const GetMedicalTranscriptionJob =
  Binding.Service<GetMedicalTranscriptionJob>(
    "AWS.Transcribe.GetMedicalTranscriptionJob",
  );
