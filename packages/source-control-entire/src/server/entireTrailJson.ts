import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  TrimmedString,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestMergeability,
  type PullRequestReviewDecision,
  type PullRequestReviewThread,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { definition } from "../shared/definition.ts";
import * as EntireUrls from "../shared/entireUrls.ts";
import * as EntireTrailBody from "./entireTrailBody.ts";

// entire-api adds fields often; only what T3 Code reads is decoded.

const Identity = Schema.Struct({
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
type Identity = typeof Identity.Type;

const Reviewer = Schema.Struct({
  login: Schema.String,
  status: Schema.String,
  identity: Schema.optional(Identity),
});

export const EntireTrail = Schema.Struct({
  number: PositiveInt,
  url: Schema.optional(Schema.String),
  title: TrimmedString,
  status: Schema.String,
  ready_for_review: Schema.optional(Schema.Boolean),
  branch: Schema.NullOr(Schema.String),
  original_branch: Schema.optional(Schema.NullOr(Schema.String)),
  base: Schema.String,
  author: Schema.NullOr(
    Schema.Struct({ login: Schema.NullOr(Schema.String), identity: Schema.optional(Identity) }),
  ),
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(Reviewer))),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  merged_at: Schema.optional(Schema.NullOr(IsoDateTime)),
  parent: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: PositiveInt,
        url: Schema.optional(Schema.String),
        project_id: Schema.optional(Schema.String),
        /** The project trail's own route, served by the project's cell. */
        path: Schema.optional(Schema.String),
        primary_processing_cell: Schema.optional(Schema.String),
        jurisdiction: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type EntireTrail = typeof EntireTrail.Type;

export const EntireTrails = Schema.Struct({
  items: Schema.Array(EntireTrail),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const EntireProjectTrails = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      changes: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              repositoryId: Schema.String,
              number: Schema.Int,
              mergeability: Schema.optional(
                Schema.NullOr(Schema.Struct({ conflict_status: Schema.String })),
              ),
            }),
          ),
        ),
      ),
    }),
  ),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
});
export type EntireProjectTrails = typeof EntireProjectTrails.Type;

/** The conflict verdict alone: Entire's `mergeable` folds in every gate. */
function conflictMergeability(conflictStatus: string | undefined): PullRequestMergeability {
  switch (conflictStatus) {
    case "clean":
      return "mergeable";
    case "conflicting":
    case "conflicts":
      return "conflicting";
    default:
      return "unknown";
  }
}

export function projectListMergeability(
  items: EntireProjectTrails["items"],
  repoId: string,
): ReadonlyMap<number, PullRequestMergeability> {
  const verdicts = new Map<number, PullRequestMergeability>();
  for (const item of items)
    for (const change of item.changes ?? [])
      if (change.repositoryId === repoId)
        verdicts.set(change.number, conflictMergeability(change.mergeability?.conflict_status));
  return verdicts;
}

const ActionAvailability = Schema.Struct({
  state: Schema.String,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
});

const CheckRun = Schema.Struct({
  name: TrimmedString,
  status: Schema.String,
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  details_url: Schema.optional(Schema.NullOr(Schema.String)),
  app_name: Schema.optional(Schema.NullOr(Schema.String)),
});
type CheckRun = typeof CheckRun.Type;

const GateResult = Schema.Struct({
  gate_key: Schema.String,
  gate_type: Schema.String,
  blocking: Schema.Boolean,
  status: Schema.String,
  rationale: Schema.optional(Schema.NullOr(Schema.String)),
});
type GateResult = typeof GateResult.Type;

const Mergeability = Schema.Struct({
  head_sha: Schema.optional(Schema.NullOr(Schema.String)),
  conflict_status: Schema.optional(Schema.String),
  behind_by: Schema.optional(Schema.Int),
  comparison_status: Schema.optional(Schema.String),
  checks: Schema.optional(
    Schema.Struct({ availability: Schema.String, runs: Schema.Array(CheckRun) }),
  ),
  gates: Schema.optional(Schema.NullOr(Schema.Array(GateResult))),
});

export const EntireTrailDetail = Schema.Struct({
  ...EntireTrail.fields,
  body_document: Schema.optional(
    Schema.Struct({
      text_snapshot: Schema.String,
      content_json: Schema.optional(Schema.Unknown),
      etag: Schema.optional(Schema.String),
    }),
  ),
  head_sha: Schema.optional(Schema.NullOr(Schema.String)),
  merge_base_sha: Schema.optional(Schema.NullOr(Schema.String)),
  actions: Schema.optional(
    Schema.Struct({ approve: ActionAvailability, merge: ActionAvailability }),
  ),
  mergeability: Schema.optional(Schema.NullOr(Mergeability)),
  gh_pr_id: Schema.optional(Schema.NullOr(Schema.Int)),
});
export type EntireTrailDetail = typeof EntireTrailDetail.Type;

const TimelineActor = Schema.NullOr(
  Schema.Struct({ login: Schema.NullOr(Schema.String), identity: Schema.optional(Identity) }),
);

export const EntireTimeline = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: TrimmedString,
      kind: Schema.String,
      actor: Schema.optional(TimelineActor),
      occurredAt: Schema.NullOr(IsoDateTime),
      approvalStatus: Schema.optional(Schema.String),
      body: Schema.optional(Schema.NullOr(Schema.String)),
      title: Schema.optional(Schema.String),
      commitSha: Schema.optional(Schema.String),
    }),
  ),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
});
export type EntireTimeline = typeof EntireTimeline.Type;

const DiscussionSummary = Schema.Struct({
  id: TrimmedString,
  title: Schema.String,
  resolved: Schema.Boolean,
  created_at: IsoDateTime,
  review_comment: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        /** A finding's own text; its discussion's messages are only the replies to it. */
        id: Schema.optional(TrimmedString),
        body: Schema.optional(Schema.NullOr(Schema.String)),
        severity: Schema.optional(Schema.NullOr(Schema.String)),
        actor_display_name: Schema.optional(Schema.NullOr(Schema.String)),
        actor_identity: Schema.optional(Schema.NullOr(Identity)),
        created_at: Schema.optional(IsoDateTime),
        location: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              file_path: Schema.optional(Schema.NullOr(Schema.String)),
              start_line: Schema.optional(Schema.NullOr(Schema.Int)),
            }),
          ),
        ),
      }),
    ),
  ),
});

export const EntireDiscussions = Schema.Struct({
  items: Schema.Array(DiscussionSummary),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const Message = Schema.Struct({
  id: TrimmedString,
  author: Schema.String,
  identity: Schema.optional(Identity),
  created_at: IsoDateTime,
  body: Schema.String,
});

export const EntireDiscussion = Schema.Struct({
  discussion: DiscussionSummary,
  messages: Schema.Array(
    Schema.Struct({ ...Message.fields, replies: Schema.optional(Schema.Array(Message)) }),
  ),
});
export type EntireDiscussion = typeof EntireDiscussion.Type;

function toActor(
  login: string | null | undefined,
  identity: Identity | undefined,
): PullRequestActor | null {
  const handle = login?.trim();
  if (!handle) return null;
  return {
    login: handle,
    name: identity?.display_name ?? null,
    avatarUrl: identity?.avatar_url ?? null,
  };
}

export function trailState(status: string): ProviderChangeRequest["state"] {
  return status === "merged" ? "merged" : status === "closed" ? "closed" : "open";
}

/** An open trail not yet ready for review is what T3 Code calls a draft. */
export function isDraftTrail(trail: Pick<EntireTrail, "status" | "ready_for_review">): boolean {
  return (
    trail.status === "draft" ||
    (trailState(trail.status) === "open" && trail.ready_for_review === false)
  );
}

/** With the approvals gate off, Entire reads every trail as not ready and ignores readiness. */
function approvalsDisabled(detail: EntireTrailDetail): boolean {
  return detail.actions?.approve.reason === "approvals_disabled";
}

function isDraftDetail(detail: EntireTrailDetail): boolean {
  return !approvalsDisabled(detail) && isDraftTrail(detail);
}

export const EntireGateSettings = Schema.Struct({
  gates: Schema.Array(
    Schema.Struct({
      gateKey: Schema.String,
      gateType: Schema.String,
      scopeType: Schema.String,
      enabled: Schema.Boolean,
    }),
  ),
});

export function approvalsGateOn(settings: typeof EntireGateSettings.Type): boolean {
  return settings.gates.some(
    (gate) =>
      gate.scopeType === "repo" &&
      gate.gateType === "approvals" &&
      gate.gateKey === "approvals" &&
      gate.enabled,
  );
}

export function toListChangeRequest(
  trail: EntireTrail,
  repository: string,
  readinessCounts: boolean,
): ProviderChangeRequest {
  const row = toChangeRequest(trail, repository);
  return readinessCounts ? row : { ...row, isDraft: trail.status === "draft" };
}

export const trailTitle = (trail: Pick<EntireTrail, "title" | "number">) =>
  trail.title || `Trail #${trail.number}`;

export function trailHeadBranch(trail: Pick<EntireTrail, "branch" | "original_branch">): string {
  return trail.branch ?? trail.original_branch ?? "";
}

export function trailUrl(trail: Pick<EntireTrail, "url" | "number">, repository: string): string {
  const own = trail.url === undefined ? null : EntireUrls.parseEntireTrailUrl(trail.url);
  return own !== null &&
    own.number === trail.number &&
    own.repository.toLowerCase() === repository.toLowerCase()
    ? trail.url!
    : definition.changeRequestUrl({
        host: EntireUrls.ENTIRE_WEB_HOST,
        repository,
        number: trail.number,
      });
}

function reviewDecision(trail: EntireTrail): PullRequestReviewDecision | null {
  const statuses = (trail.reviewers ?? []).map((reviewer) => reviewer.status);
  if (statuses.includes("changes_requested")) return "changes-requested";
  if (statuses.includes("approved")) return "approved";
  return statuses.length > 0 ? "review-required" : null;
}

export function toReviewers(trail: EntireTrail): ReadonlyArray<PullRequestActor> {
  return (trail.reviewers ?? []).flatMap((reviewer) => {
    const actor = toActor(reviewer.login, reviewer.identity);
    return actor === null ? [] : [actor];
  });
}

export function toChangeRequest(trail: EntireTrail, repository: string): ProviderChangeRequest {
  return {
    number: trail.number,
    title: trailTitle(trail),
    url: trailUrl(trail, repository),
    author: toActor(trail.author?.login, trail.author?.identity),
    headBranch: trailHeadBranch(trail),
    baseBranch: trail.base,
    state: trailState(trail.status),
    isDraft: isDraftTrail(trail),
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: trail.created_at,
    updatedAt: trail.updated_at,
    ...(trail.merged_at === undefined ? {} : { mergedAt: trail.merged_at }),
    reviewRequestLogins: toReviewers(trail).map((reviewer) => reviewer.login),
    labels: [],
    reviewDecision: reviewDecision(trail),
  };
}

export const blockingGates = (detail: EntireTrailDetail): ReadonlyArray<GateResult> =>
  (detail.mergeability?.gates ?? []).filter((gate) => gate.blocking && gate.status !== "skipped");

const gateFailed = (gate: GateResult) => gate.status === "failed" || gate.status === "error";

/** The approvals gate reads as a required review, unless a reviewer requested changes. */
function detailReviewDecision(detail: EntireTrailDetail): PullRequestReviewDecision | null {
  const fromReviewers = reviewDecision(detail);
  if (fromReviewers === "changes-requested") return fromReviewers;
  const approvals = blockingGates(detail).find((gate) => gate.gate_type === "approvals");
  if (approvals === undefined) return fromReviewers;
  return approvals.status === "passed" ? "approved" : "review-required";
}

export function toDetailChangeRequest(
  detail: EntireTrailDetail,
  repository: string,
): ProviderChangeRequest {
  return {
    ...toChangeRequest(detail, repository),
    isDraft: isDraftDetail(detail),
    reviewDecision: detailReviewDecision(detail),
  };
}

function checkStatus(run: CheckRun): PullRequestCheck["status"] {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "action_required":
      return "action-required";
    default:
      return "failure";
  }
}

const runsRead = (detail: EntireTrailDetail) =>
  detail.mergeability?.checks?.availability === "available";

function gateChecks(
  detail: EntireTrailDetail,
  repository: string,
): ReadonlyArray<PullRequestCheck> {
  const url = trailUrl(detail, repository);
  return blockingGates(detail)
    .filter(
      (gate) =>
        gate.gate_type !== "approvals" && (gate.gate_type !== "checks" || !runsRead(detail)),
    )
    .map((gate) => ({
      name: `Entire: ${gate.gate_key}`,
      status: gate.status === "passed" ? "success" : gateFailed(gate) ? "failure" : "pending",
      description: gate.rationale ?? null,
      url,
      required: true,
    }));
}

/** Reported runs mean something only when Entire says its read of them was complete. */
export function toChecks(
  detail: EntireTrailDetail,
  repository: string,
): ReadonlyArray<PullRequestCheck> {
  const runs = runsRead(detail) ? (detail.mergeability?.checks?.runs ?? []) : [];
  return sortChecks([
    ...runs
      .filter((run) => run.name)
      .map((run) => ({
        name: run.name,
        status: checkStatus(run),
        description: run.app_name ?? null,
        url: run.details_url ?? null,
      })),
    ...gateChecks(detail, repository),
  ]);
}

export function toChecksState(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | undefined {
  if (checks.length === 0) return undefined;
  if (checks.some(({ status }) => ["failure", "cancelled", "action-required"].includes(status)))
    return "failing";
  return checks.some((check) => check.status === "pending") ? "pending" : "passing";
}

/** Absent when Entire could not read the runs, so an incomplete read never clears a state. */
export function toSummaryChecksState(
  detail: EntireTrailDetail,
  repository: string,
): PullRequestChecksState | null | undefined {
  const state = toChecksState(toChecks(detail, repository));
  if (state === "failing") return state;
  if (!runsRead(detail)) return undefined;
  return state ?? null;
}

export const toMergeability = (detail: EntireTrailDetail): PullRequestMergeability =>
  conflictMergeability(detail.mergeability?.conflict_status);

/** The intent a change serves lives on its project trail, so the description links to it. */
function projectTrailLink(detail: EntireTrailDetail): string | null {
  const parent = detail.parent;
  return parent?.url && EntireUrls.isProjectTrailUrl(parent.url)
    ? `Part of trail [#${parent.number}](${parent.url}) on Entire.`
    : null;
}

const BodyDocument = Schema.Struct({
  text_snapshot: Schema.String,
  content_json: Schema.optional(Schema.Unknown),
});
type BodyDocument = typeof BodyDocument.Type;

/** A project trail, as far as its description goes. */
export const EntireProjectTrail = Schema.Struct({
  bodyDocument: Schema.optional(Schema.NullOr(BodyDocument)),
});

const PROJECT_TRAIL_PATH = /^\/api\/v1(\/(?:gh|et)\/[a-z0-9-]+\/trails\/[0-9A-HJKMNP-TV-Z]{26})$/u;

/**
 * Where the change's project trail is read and written: its route below `/api/v1`, and the cell
 * that serves it. Null for a change with no project trail, or a reference too thin to route.
 */
export function projectTrailRoute(detail: EntireTrailDetail): {
  readonly path: string;
  readonly cell: { readonly slug: string; readonly jurisdiction: string };
} | null {
  const parent = detail.parent;
  const path = parent?.path ? PROJECT_TRAIL_PATH.exec(parent.path)?.[1] : undefined;
  const slug = parent?.primary_processing_cell?.trim();
  const jurisdiction = parent?.jurisdiction?.trim();
  return path && slug && jurisdiction ? { path, cell: { slug, jurisdiction } } : null;
}

/**
 * The description shown for a change: its project trail's when that was read, since the
 * change's own is a copy taken when it was linked, else the change's.
 */
export function changeBody(
  detail: EntireTrailDetail,
  description: BodyDocument | null | undefined = detail.body_document,
): string {
  const body = description ? EntireTrailBody.trailBodyMarkdown(description) : "";
  const link = projectTrailLink(detail);
  if (link === null) return body;
  return body.length === 0 ? link : `${link}\n\n${body}`;
}

export function ownBody(detail: EntireTrailDetail, body: string): string {
  const link = projectTrailLink(detail);
  if (link === null || !body.startsWith(link)) return body;
  return body
    .slice(link.length)
    .replace(/^\s*\n/u, "")
    .trimStart();
}

export function headSha(detail: EntireTrailDetail): string | null {
  return detail.head_sha ?? detail.mergeability?.head_sha ?? null;
}

// `permission_denied` on merge or approve is how Entire says the reader has no push access.
// Merge is offered on any open trail, as GitHub does; the merge re-reads the gates.
export function toViewerPermissions(
  detail: EntireTrailDetail,
  repository: string,
): PullRequestViewerPermissions {
  const actions = detail.actions;
  const canWrite =
    actions !== undefined &&
    actions.merge.reason !== "permission_denied" &&
    actions.approve.reason !== "permission_denied";
  const state = trailState(detail.status);
  // Only a branch Entire hosts, and not one backed by a pull request.
  const updatable =
    canWrite &&
    state === "open" &&
    EntireUrls.entireRepositoryPath(repository)?.forge === "et" &&
    (detail.gh_pr_id ?? null) === null;
  const readiness =
    state !== "open" || approvalsDisabled(detail)
      ? []
      : isDraftTrail(detail)
        ? (["ready"] as const)
        : (["draft"] as const);
  return {
    actions: canWrite
      ? [
          ...readiness,
          ...(state === "open" ? (["close"] as const) : []),
          ...(state === "closed" ? (["reopen"] as const) : []),
          ...(state === "open" ? (["merge"] as const) : []),
          ...(updatable ? (["update-branch"] as const) : []),
        ]
      : [],
    comment: true,
    resolve: canWrite,
    verdicts: [
      ...(canWrite ? (["comment"] as const) : []),
      ...(actions?.approve.state === "enabled" ? (["approve"] as const) : []),
    ],
    requestReviewers: false,
    labels: false,
    editChangeRequest: canWrite,
    updateMethods: updatable ? ["merge"] : [],
  };
}

const REVIEW_STATES: Readonly<Record<string, string>> = {
  approved: "approved",
  approve: "approved",
  changes_requested: "changes_requested",
  request_changes: "changes_requested",
};

interface Remark {
  readonly id: string;
  readonly author: PullRequestActor | null;
  readonly body: string;
  readonly createdAt: string;
  readonly url: null;
  readonly canEdit?: false;
}

const MESSAGE_ID = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/u;

export function messageRef(
  commentId: string,
): { readonly discussion: string; readonly message: string } | null {
  const match = MESSAGE_ID.exec(commentId);
  return match?.[1] && match[2] ? { discussion: match[1], message: match[2] } : null;
}

/** T3 shows no severity of its own, so a finding carries it at the start of its text. */
const findingBody = (body: string, severity: string | null | undefined) => {
  const label = severity?.trim();
  return label
    ? `**${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()}** · ${body}`
    : body;
};

function remarks(discussion: EntireDiscussion): ReadonlyArray<Remark> {
  const finding = discussion.discussion.review_comment;
  const root: ReadonlyArray<Remark> =
    finding?.id && finding.body?.trim() && finding.created_at
      ? [
          {
            id: finding.id,
            author: toActor(finding.actor_display_name, finding.actor_identity ?? undefined),
            body: findingBody(finding.body, finding.severity),
            createdAt: finding.created_at,
            url: null,
            canEdit: false,
          },
        ]
      : [];
  const remark = (message: typeof Message.Type, reply: boolean) => ({
    id: `${discussion.discussion.id}:${message.id}`,
    author: toActor(message.author, message.identity),
    body: message.body,
    createdAt: message.created_at,
    url: null,
    ...(reply ? { canEdit: false as const } : {}),
  });
  const replies = discussion.messages.flatMap((message) => [
    ...(message.id ? [remark(message, false)] : []),
    ...(message.replies ?? []).filter((reply) => reply.id).map((reply) => remark(reply, true)),
  ]);
  return [...root, ...replies].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// T3 Code threads need a file and line; every other discussion reads as the conversation.
export function toActivity(input: {
  readonly timeline: EntireTimeline;
  readonly discussions: ReadonlyArray<EntireDiscussion>;
  readonly discussionsTruncated: boolean;
}): ProviderChangeRequestActivity {
  const comments: Array<PullRequestComment> = [];
  const reviewThreads: Array<PullRequestReviewThread> = [];
  for (const discussion of input.discussions) {
    const location = discussion.discussion.review_comment?.location;
    const path = location?.file_path?.trim();
    const line = location?.start_line ?? null;
    const messages = remarks(discussion);
    if (path && line !== null && line > 0) {
      reviewThreads.push({
        id: discussion.discussion.id,
        path,
        line,
        side: "right",
        isResolved: discussion.discussion.resolved,
        isOutdated: false,
        comments: messages,
      });
      comments.push(
        ...messages.map((remark) => ({
          ...remark,
          kind: "review-comment" as const,
          path,
          reviewState: null,
        })),
      );
    } else {
      comments.push(
        ...messages.map((remark) => ({
          ...remark,
          kind: "issue-comment" as const,
          path: null,
          reviewState: null,
        })),
      );
    }
  }
  const commits: Array<ProviderChangeRequestActivity["commits"][number]> = [];
  for (const event of input.timeline.items) {
    if (event.kind === "approval" && event.id && event.occurredAt !== null) {
      comments.push({
        id: event.id,
        kind: "review",
        author: toActor(event.actor?.login, event.actor?.identity),
        body: event.body ?? "",
        createdAt: event.occurredAt,
        url: null,
        path: null,
        reviewState: REVIEW_STATES[event.approvalStatus ?? ""] ?? "commented",
      });
    } else if (event.kind === "commit" && event.commitSha && event.occurredAt !== null) {
      commits.push({
        oid: event.commitSha,
        messageHeadline: event.title ?? "",
        committedDate: event.occurredAt,
      });
    }
  }
  return {
    comments: comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    commentCount: comments.length,
    commentsTruncated: input.discussionsTruncated || Boolean(input.timeline.nextPageToken),
    reviewThreads,
    commits: commits.toSorted((a, b) => a.committedDate.localeCompare(b.committedDate)),
  };
}
