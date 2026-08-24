import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListMedicalTranscriptionJobs` — list the medical transcription jobs in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListMedicalTranscriptionJobs` on `*`.
 *
 * @binding
 * @section Medical Transcription Jobs
 * @example List Medical Transcription Jobs
 * ```typescript
 * // init
 * const listMedicalTranscriptionJobs = yield* AWS.Transcribe.ListMedicalTranscriptionJobs();
 *
 * // runtime
 * const { MedicalTranscriptionJobSummaries } = yield* listMedicalTranscriptionJobs({ MaxResults: 10 });
 * ```
 */
export interface ListMedicalTranscriptionJobs extends Binding.Service<
  ListMedicalTranscriptionJobs,
  "AWS.Transcribe.ListMedicalTranscriptionJobs",
  () => Effect.Effect<
    (
      request?: transcribe.ListMedicalTranscriptionJobsRequest,
    ) => Effect.Effect<
      transcribe.ListMedicalTranscriptionJobsResponse,
      transcribe.ListMedicalTranscriptionJobsError
    >
  >
> {}
export const ListMedicalTranscriptionJobs =
  Binding.Service<ListMedicalTranscriptionJobs>(
    "AWS.Transcribe.ListMedicalTranscriptionJobs",
  );
