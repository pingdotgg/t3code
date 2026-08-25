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
  // Which PostHog products emitted the signals behind the report, e.g.
  // "error_tracking", "conversations", "signals_scout".
  source_products: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // PostHog routed this report to the reading user: they are one of its
  // suggested reviewers. The inbox's "For you" section is exactly this flag.
  is_suggested_reviewer: Schema.optional(Schema.NullOr(Schema.Boolean)),
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

/** A commit that put a reviewer on the hook, with the sentence explaining why. */
export const PostHogRelevantCommit = Schema.Struct({
  sha: Schema.String,
  reason: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  url: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type PostHogRelevantCommit = typeof PostHogRelevantCommit.Type;

/** PostHog enriches reviewers with the org member they resolved to at read time. */
export const PostHogReviewerUser = Schema.Struct({
  uuid: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  first_name: Schema.optional(Schema.NullOr(Schema.String)),
  last_name: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PostHogReviewerUser = typeof PostHogReviewerUser.Type;

export const PostHogSuggestedReviewer = Schema.Struct({
  github_login: Schema.String,
  github_name: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  is_skill_owner: Schema.optional(Schema.NullOr(Schema.Boolean)),
  // Why this person was named. Kept because this app has no pull request yet
  // to carry the reasoning: the report is where the routing is justified.
  relevant_commits: Schema.Array(PostHogRelevantCommit).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  user: Schema.optional(Schema.NullOr(PostHogReviewerUser)),
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

/**
 * One signal behind a report: the support ticket, error-tracking issue, or
 * scout finding that triggered it. This is the report's primary evidence —
 * distinct from `signal_finding` artefacts, which are the agent's own notes
 * about investigating it.
 */
export const PostHogSignal = Schema.Struct({
  signal_id: Schema.String,
  content: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  source_product: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  source_type: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  source_id: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: Schema.optional(Schema.NullOr(Schema.String)),
  // Product-specific payload; its shape depends on the source, so it stays
  // opaque here and each source's card reads the keys it knows.
  extra: Schema.optional(Schema.Unknown),
});
export type PostHogSignal = typeof PostHogSignal.Type;

export const PostHogReportSignalsInput = Schema.Struct({
  reportId: PostHogReportId,
});
export type PostHogReportSignalsInput = typeof PostHogReportSignalsInput.Type;

export const PostHogReportSignalsResult = Schema.Struct({
  signals: Schema.Array(PostHogSignal),
});
export type PostHogReportSignalsResult = typeof PostHogReportSignalsResult.Type;

export const PostHogReportArtefactsInput = Schema.Struct({
  reportId: PostHogReportId,
});
export type PostHogReportArtefactsInput = typeof PostHogReportArtefactsInput.Type;

export const PostHogReportArtefactsResult = Schema.Struct({
  artefacts: Schema.Array(PostHogReportArtefact),
});
export type PostHogReportArtefactsResult = typeof PostHogReportArtefactsResult.Type;

/**
 * The states PostHog's `SignalReportStateRequestSerializer` accepts.
 * "suppressed" archives a report, "potential" returns it to the inbox.
 */
export const PostHogReportTargetState = Schema.Literals(["suppressed", "potential", "resolved"]);
export type PostHogReportTargetState = typeof PostHogReportTargetState.Type;

export const PostHogSetReportStateInput = Schema.Struct({
  reportId: PostHogReportId,
  state: PostHogReportTargetState,
});
export type PostHogSetReportStateInput = typeof PostHogSetReportStateInput.Type;

export const PostHogSetReportStateResult = Schema.Struct({
  report: PostHogReport,
});
export type PostHogSetReportStateResult = typeof PostHogSetReportStateResult.Type;

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

// ── Inbox sections ─────────────────────────────────────────────────────────

/**
 * What a section keeps. Every field is a narrowing: an empty array or an
 * absent flag means "do not filter on this", so `{}` matches every report.
 * Only fields the list payload already carries are filterable, so a section
 * costs no extra request.
 */
export const PostHogInboxFilter = Schema.Struct({
  statuses: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  priorities: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  actionabilities: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  sourceProducts: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** True keeps only reports PostHog routed to the reading user. */
  forYou: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hasPullRequest: Schema.optional(Schema.NullOr(Schema.Boolean)),
  alreadyAddressed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  titleContains: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type PostHogInboxFilter = typeof PostHogInboxFilter.Type;

/** A section the user named and defined. Built-in sections are not stored. */
export const PostHogInboxSection = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  filter: PostHogInboxFilter,
  /** Sections start folded when the reader collapsed them last. */
  collapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type PostHogInboxSection = typeof PostHogInboxSection.Type;

/** The report's page in the PostHog inbox. */
export function postHogReportUrl(input: {
  readonly host: string;
  readonly projectId: string;
  readonly reportId: string;
}): string {
  const host = input.host.replace(/\/+$/, "");
  return `${host}/project/${input.projectId}/inbox/reports/${input.reportId}`;
}
