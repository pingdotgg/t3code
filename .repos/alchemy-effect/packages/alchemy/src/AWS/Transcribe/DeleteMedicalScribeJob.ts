import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteMedicalScribeJob` — delete a Medical Scribe job.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteMedicalScribeJob` on `*`.
 *
 * @binding
 * @section Medical Scribe Jobs
 * @example Delete a Medical Scribe Job
 * ```typescript
 * // init
 * const deleteMedicalScribeJob = yield* AWS.Transcribe.DeleteMedicalScribeJob();
 *
 * // runtime
 * yield* deleteMedicalScribeJob({ MedicalScribeJobName: "my-visit" });
 * ```
 */
export interface DeleteMedicalScribeJob extends Binding.Service<
  DeleteMedicalScribeJob,
  "AWS.Transcribe.DeleteMedicalScribeJob",
  () => Effect.Effect<
    (
      request: transcribe.DeleteMedicalScribeJobRequest,
    ) => Effect.Effect<
      transcribe.DeleteMedicalScribeJobResponse,
      transcribe.DeleteMedicalScribeJobError
    >
  >
> {}
export const DeleteMedicalScribeJob = Binding.Service<DeleteMedicalScribeJob>(
  "AWS.Transcribe.DeleteMedicalScribeJob",
);
