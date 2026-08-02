import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListMedicalScribeJobs` — list the Medical Scribe jobs in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListMedicalScribeJobs` on `*`.
 *
 * @binding
 * @section Medical Scribe Jobs
 * @example List Medical Scribe Jobs
 * ```typescript
 * // init
 * const listMedicalScribeJobs = yield* AWS.Transcribe.ListMedicalScribeJobs();
 *
 * // runtime
 * const { MedicalScribeJobSummaries } = yield* listMedicalScribeJobs({ MaxResults: 10 });
 * ```
 */
export interface ListMedicalScribeJobs extends Binding.Service<
  ListMedicalScribeJobs,
  "AWS.Transcribe.ListMedicalScribeJobs",
  () => Effect.Effect<
    (
      request?: transcribe.ListMedicalScribeJobsRequest,
    ) => Effect.Effect<
      transcribe.ListMedicalScribeJobsResponse,
      transcribe.ListMedicalScribeJobsError
    >
  >
> {}
export const ListMedicalScribeJobs = Binding.Service<ListMedicalScribeJobs>(
  "AWS.Transcribe.ListMedicalScribeJobs",
);
