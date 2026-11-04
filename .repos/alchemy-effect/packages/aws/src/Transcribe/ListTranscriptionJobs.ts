import type * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `transcribe:ListTranscriptionJobs` — list the batch transcription jobs in the account, optionally filtered by status or name prefix.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListTranscriptionJobs` on `*`.
 *
 * ### Batch Transcription Jobs
 * **Example:** List Transcription Jobs
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
 *
 * @binding
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
