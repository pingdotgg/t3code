/**
 * PostHog self-driving reports, as the server proxies them from the PostHog
 * REST API. Field names follow PostHog's `SignalReportSerializer` and
 * `SignalReportArtefactSerializer`; only the fields the client renders are
 * decoded, and artefact content stays lenient so unknown artefact types
 * round-trip untouched.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PostHogReportId = TrimmedNonEmptyString.pipe(Schema.brand("PostHogReportId"));
export type PostHogReportId = typeof PostHogReportId.Type;

// PostHog's `SignalReport.Status`. Kept as a plain string so a new status on
// the PostHog side does not break decoding here.
export const PostHogReportStatus = Schema.String;
export type PostHogReportStatus = typeof PostHogReportStatus.Type;

export const PostHogReportChart = Schema.Struct({
  chart_id: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(Schema.NullOr(Schema.String)),
  query: Schema.optional(Schema.Unknown),
});
export type PostHogReportChart = typeof PostHogReportChart.Type;

export const PostHogReport = Schema.Struct({
  id: PostHogReportId,
  title: Schema.String,
  summary: Schema.NullOr(Schema.String),
  status: PostHogReportStatus,
  created_at: Schema.String,
  updated_at: Schema.String,
  priority: Schema.optional(Schema.NullOr(Schema.String)),
  actionability: Schema.optional(Schema.NullOr(Schema.String)),
  already_addressed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  artefact_count: Schema.optional(Schema.NullOr(Schema.Number)),
  signal_count: Schema.optional(Schema.NullOr(Schema.Number)),
  charts: Schema.optional(Schema.NullOr(Schema.Array(PostHogReportChart))),
  implementation_pr_url: Schema.optional(Schema.NullOr(Schema.String)),
  implementation_pr_merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type PostHogReport = typeof PostHogReport.Type;

// PostHog's `SignalReportArtefact.ArtefactType`, kept open for the same reason as status.
export const PostHogReportArtefactType = Schema.String;
export type PostHogReportArtefactType = typeof PostHogReportArtefactType.Type;

export const PostHogReportArtefact = Schema.Struct({
  id: Schema.String,
  type: PostHogReportArtefactType,
  content: Schema.Unknown,
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PostHogReportArtefact = typeof PostHogReportArtefact.Type;

// ── Artefact content shapes (PostHog `artefact_schemas.py`) ─────────────────

export const PostHogSignalFinding = Schema.Struct({
  signal_id: Schema.String,
  relevant_code_paths: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  relevant_commit_hashes: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  data_queried: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  verified: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type PostHogSignalFinding = typeof PostHogSignalFinding.Type;

export const PostHogPriorityAssessment = Schema.Struct({
  priority: Schema.String,
  explanation: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  dollar_value: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type PostHogPriorityAssessment = typeof PostHogPriorityAssessment.Type;

export const PostHogActionabilityAssessment = Schema.Struct({
  actionability: Schema.String,
  explanation: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  already_addressed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type PostHogActionabilityAssessment = typeof PostHogActionabilityAssessment.Type;

export const PostHogCodeReference = Schema.Struct({
  file_path: Schema.String,
  start_line: Schema.Number,
  end_line: Schema.Number,
  contents: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  relevance_note: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type PostHogCodeReference = typeof PostHogCodeReference.Type;

export const PostHogSuggestedReviewer = Schema.Struct({
  github_login: Schema.String,
  github_name: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  is_skill_owner: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type PostHogSuggestedReviewer = typeof PostHogSuggestedReviewer.Type;
export const PostHogSuggestedReviewers = Schema.Array(PostHogSuggestedReviewer);

export const PostHogRepoSelection = Schema.Struct({
  repository: Schema.NullOr(Schema.String),
  reason: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type PostHogRepoSelection = typeof PostHogRepoSelection.Type;

export const PostHogDismissal = Schema.Struct({
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PostHogDismissal = typeof PostHogDismissal.Type;

// ── RPC payloads ───────────────────────────────────────────────────────────

export const PostHogReportsListInput = Schema.Struct({
  // Comma-separated PostHog statuses. Absent lists every non-suppressed report.
  status: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(Schema.Number),
});
export type PostHogReportsListInput = typeof PostHogReportsListInput.Type;

export const PostHogReportsListResult = Schema.Struct({
  reports: Schema.Array(PostHogReport),
  count: Schema.Number,
});
export type PostHogReportsListResult = typeof PostHogReportsListResult.Type;

export const PostHogReportArtefactsInput = Schema.Struct({
  reportId: PostHogReportId,
});
export type PostHogReportArtefactsInput = typeof PostHogReportArtefactsInput.Type;

export const PostHogReportArtefactsResult = Schema.Struct({
  artefacts: Schema.Array(PostHogReportArtefact),
});
export type PostHogReportArtefactsResult = typeof PostHogReportArtefactsResult.Type;

// ── Errors ─────────────────────────────────────────────────────────────────

/** Host, project id, or API key is missing. The UI links to settings. */
export class PostHogNotConfiguredError extends Schema.TaggedErrorClass<PostHogNotConfiguredError>()(
  "PostHogNotConfiguredError",
  {
    missing: Schema.Array(Schema.Literals(["host", "projectId", "apiKey"])),
  },
) {
  override get message(): string {
    return "PostHog not configured";
  }
}

/** PostHog answered 401 or 403: the key is wrong, expired, or lacks scope. */
export class PostHogUnauthorizedError extends Schema.TaggedErrorClass<PostHogUnauthorizedError>()(
  "PostHogUnauthorizedError",
  {
    status: Schema.Number,
  },
) {
  override get message(): string {
    return "PostHog rejected the API key";
  }
}

/** Any other failure talking to PostHog: network, non-2xx, undecodable body. */
export class PostHogRequestError extends Schema.TaggedErrorClass<PostHogRequestError>()(
  "PostHogRequestError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const PostHogRpcError = Schema.Union([
  PostHogNotConfiguredError,
  PostHogUnauthorizedError,
  PostHogRequestError,
]);
export type PostHogRpcError = typeof PostHogRpcError.Type;

/** The report's page in the PostHog inbox. */
export function postHogReportUrl(input: {
  readonly host: string;
  readonly projectId: string;
  readonly reportId: string;
}): string {
  const host = input.host.replace(/\/+$/, "");
  return `${host}/project/${input.projectId}/inbox/reports/${input.reportId}`;
}
