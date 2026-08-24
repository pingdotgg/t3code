import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListTranscriptionJobs` — list the batch transcription jobs in the account, optionally filtered by status or name prefix.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListTranscriptionJobs` on `*`.
 *
 * @binding
 * @section Batch Transcription Jobs
 * @example List Transcription Jobs
 * ```typescript
 * // init
 * const listTranscriptionJobs = yield* AWS.Transcribe.ListTranscriptionJobs();
 *
 * // runtime
 * const { TranscriptionJobSummaries } = yield* listTranscriptionJobs({
 *   Status: "COMPLETED",
 *   MaxResults: 10,
 * });
 * ```
 */
export interface ListTranscriptionJobs extends Binding.Service<
  ListTranscriptionJobs,
  "AWS.Transcribe.ListTranscriptionJobs",
  () => Effect.Effect<
    (
      request?: transcribe.ListTranscriptionJobsRequest,
    ) => Effect.Effect<
      transcribe.ListTranscriptionJobsResponse,
      transcribe.ListTranscriptionJobsError
    >
  >
> {}
export const ListTranscriptionJobs = Binding.Service<ListTranscriptionJobs>(
  "AWS.Transcribe.ListTranscriptionJobs",
);
