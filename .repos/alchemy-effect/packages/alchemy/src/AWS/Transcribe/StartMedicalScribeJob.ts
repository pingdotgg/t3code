import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartMedicalScribeJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartMedicalScribeJobRequest extends Omit<
  transcribe.StartMedicalScribeJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Transcribe assumes to access your Amazon S3 data.
   * @default the data-access role bound via `StartMedicalScribeJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `transcribe:StartMedicalScribeJob` — start an AWS HealthScribe job that transcribes a patient-clinician conversation and generates preliminary clinical notes.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Transcribe assumes to read your Amazon S3 data and write results;
 * its trust policy must allow `transcribe.amazonaws.com`). The role's ARN
 * is injected as `DataAccessRoleArn` on every runtime request and the host
 * is granted `iam:PassRole` on it alongside `transcribe:StartMedicalScribeJob`
 * (which has no resource-level IAM).
 *
 * @binding
 * @section Medical Scribe Jobs
 * @example Start a Medical Scribe Job
 * ```typescript
 * // init — bind the Transcribe data-access role
 * const startMedicalScribeJob = yield* AWS.Transcribe.StartMedicalScribeJob(dataAccessRole);
 *
 * // runtime
 * const { MedicalScribeJob } = yield* startMedicalScribeJob({
 *   MedicalScribeJobName: "my-visit",
 *   Media: { MediaFileUri: "s3://my-bucket/visits/visit.wav" },
 *   OutputBucketName: "my-output-bucket",
 *   Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 2 },
 * });
 * ```
 */
export interface StartMedicalScribeJob extends Binding.Service<
  StartMedicalScribeJob,
  "AWS.Transcribe.StartMedicalScribeJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartMedicalScribeJobRequest,
    ) => Effect.Effect<
      transcribe.StartMedicalScribeJobResponse,
      transcribe.StartMedicalScribeJobError
    >
  >
> {}
export const StartMedicalScribeJob = Binding.Service<StartMedicalScribeJob>(
  "AWS.Transcribe.StartMedicalScribeJob",
);
