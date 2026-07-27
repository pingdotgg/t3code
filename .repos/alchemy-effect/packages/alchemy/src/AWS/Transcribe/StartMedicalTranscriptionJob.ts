import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:StartMedicalTranscriptionJob` — start an asynchronous medical transcription job over an audio file in S3 (output goes to your bucket).
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:StartMedicalTranscriptionJob` on `*`.
 *
 * @binding
 * @section Medical Transcription Jobs
 * @example Start a Medical Transcription Job
 * ```typescript
 * // init
 * const startMedicalTranscriptionJob = yield* AWS.Transcribe.StartMedicalTranscriptionJob();
 *
 * // runtime
 * const { MedicalTranscriptionJob } = yield* startMedicalTranscriptionJob({
 *   MedicalTranscriptionJobName: "my-medical-job",
 *   LanguageCode: "en-US",
 *   Media: { MediaFileUri: "s3://my-bucket/dictation.wav" },
 *   OutputBucketName: "my-output-bucket",
 *   Specialty: "PRIMARYCARE",
 *   Type: "DICTATION",
 * });
 * ```
 */
export interface StartMedicalTranscriptionJob extends Binding.Service<
  StartMedicalTranscriptionJob,
  "AWS.Transcribe.StartMedicalTranscriptionJob",
  () => Effect.Effect<
    (
      request: transcribe.StartMedicalTranscriptionJobRequest,
    ) => Effect.Effect<
      transcribe.StartMedicalTranscriptionJobResponse,
      transcribe.StartMedicalTranscriptionJobError
    >
  >
> {}
export const StartMedicalTranscriptionJob =
  Binding.Service<StartMedicalTranscriptionJob>(
    "AWS.Transcribe.StartMedicalTranscriptionJob",
  );
