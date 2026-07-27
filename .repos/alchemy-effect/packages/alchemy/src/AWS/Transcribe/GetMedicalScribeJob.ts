import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:GetMedicalScribeJob` — read a Medical Scribe job's status and, once complete, the clinical note and transcript locations.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetMedicalScribeJob` on `*`.
 *
 * @binding
 * @section Medical Scribe Jobs
 * @example Poll a Medical Scribe Job
 * ```typescript
 * // init
 * const getMedicalScribeJob = yield* AWS.Transcribe.GetMedicalScribeJob();
 *
 * // runtime
 * const { MedicalScribeJob } = yield* getMedicalScribeJob({
 *   MedicalScribeJobName: "my-visit",
 * });
 * ```
 */
export interface GetMedicalScribeJob extends Binding.Service<
  GetMedicalScribeJob,
  "AWS.Transcribe.GetMedicalScribeJob",
  () => Effect.Effect<
    (
      request: transcribe.GetMedicalScribeJobRequest,
    ) => Effect.Effect<
      transcribe.GetMedicalScribeJobResponse,
      transcribe.GetMedicalScribeJobError
    >
  >
> {}
export const GetMedicalScribeJob = Binding.Service<GetMedicalScribeJob>(
  "AWS.Transcribe.GetMedicalScribeJob",
);
