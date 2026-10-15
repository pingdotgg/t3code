import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestActor, PullRequestLabel, PullRequestState } from "./pullRequest.ts";

/**
 * Which tracker an issue lives in. Git hosts reuse their `SourceControlProviderKind` spelling
 * (`github`, `gitlab`); standalone trackers get their own (`linear`, `jira`). Branded apart from
 * the source control kind because the two sets are not the same: Bitbucket is a git host with no
 * tracker, and Linear is a tracker with no git host.
 */
export const IssueTrackerKind = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
).pipe(Schema.brand("IssueTrackerKind"));
export type IssueTrackerKind = typeof IssueTrackerKind.Type;

export const IssueActor = PullRequestActor;
export type IssueActor = typeof IssueActor.Type;

export const IssueLabel = PullRequestLabel;
export type IssueLabel = typeof IssueLabel.Type;

/**
 * Where an issue stands, in two parts: the category every tracker has, and the name this tracker
 * gives it. GitHub only has the two; Linear and Jira have a workflow of their own ("In Review",
 * "Backlog"), which `name` carries verbatim so the page can show the tracker's word while every
 * filter and badge keys off `category`.
 */
export const IssueStateCategory = Schema.Literals(["open", "closed"]);
export type IssueStateCategory = typeof IssueStateCategory.Type;

export const IssueState = Schema.Struct({
  category: IssueStateCategory,
  name: TrimmedNonEmptyString,
  /** Why it was closed, where the tracker records one (GitHub: `completed` / `not-planned`). */
  closeReason: Schema.optional(TrimmedNonEmptyString),
});
export type IssueState = typeof IssueState.Type;

/** What a listing asks for: either category, or both. */
export const IssueListState = Schema.Literals(["all", "open", "closed"]);
export type IssueListState = typeof IssueListState.Type;

export const IssueInvolvement = Schema.Literals(["all", "assigned", "authored", "mentioned"]);
export type IssueInvolvement = typeof IssueInvolvement.Type;

export const IssueReactionContent = Schema.Literals([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export type IssueReactionContent = typeof IssueReactionContent.Type;

export const IssueReaction = Schema.Struct({
  content: IssueReactionContent,
  count: PositiveInt,
  /** Who reacted, as far as the tracker named them; the viewer is left out and shown as "You". */
  actors: Schema.Array(TrimmedNonEmptyString),
  viewerHasReacted: Schema.Boolean,
});
export type IssueReaction = typeof IssueReaction.Type;

/**
 * Addresses one issue. `tracker` picks the driver, `scope` is the tracker's own container — the
 * `owner/repo` path on a git host, a team or project key on Linear and Jira — and `key` is the
 * issue's native id within it: `"123"` on GitHub, `"ENG-123"` on Linear. `host` is where the
 * tracker is served from, for a kind that can be self-hosted (GitHub Enterprise, GitLab, Forgejo);
 * absent means the kind's public host.
 *
 * `projectId` names the project whose checkout and credentials serve the read. An issue outside
 * every project's own scope can still be read through any project on the same tracker and host,
 * but the service refuses to write to it.
 */
export const IssueRef = Schema.Struct({
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  host: Schema.optional(TrimmedNonEmptyString),
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
});
export type IssueRef = typeof IssueRef.Type;

/** A scope with no issue in it, for reads about the container itself: templates, candidates. */
export const IssueScopeRef = Schema.Struct({
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  host: Schema.optional(TrimmedNonEmptyString),
  scope: TrimmedNonEmptyString,
});
export type IssueScopeRef = typeof IssueScopeRef.Type;

/** One row of a listing. Carries everything a list needs and nothing a detail needs. */
export const IssueSummary = Schema.Struct({
  tracker: IssueTrackerKind,
  host: TrimmedNonEmptyString,
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  /** How the tracker writes the key for people: `#123` on a git host, `ENG-123` on Linear. */
  displayKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  state: IssueState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  assignees: Schema.Array(IssueActor),
  labels: Schema.Array(IssueLabel),
  commentCount: NonNegativeInt,
});
export type IssueSummary = typeof IssueSummary.Type;

export const IssueListEntry = Schema.Struct({
  ...IssueSummary.fields,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
});
export type IssueListEntry = typeof IssueListEntry.Type;

export const IssueComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Schema.NullOr(IssueActor),
  body: Schema.String,
  createdAt: IsoDateTime,
  url: Schema.NullOr(Schema.String),
  /** Absent from a tracker with no reactions, which differs from none on this comment. */
  reactions: Schema.optional(Schema.Array(IssueReaction)),
});
export type IssueComment = typeof IssueComment.Type;

/**
 * Something that happened to an issue that nobody wrote words for: it was closed, labelled,
 * assigned, renamed. Kinds are the common vocabulary; a tracker drops what it cannot map rather
 * than guessing.
 */
export const IssueEventKind = Schema.Literals([
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "renamed",
  "referenced",
  "state-changed",
]);
export type IssueEventKind = typeof IssueEventKind.Type;

export const IssueEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: IssueEventKind,
  actor: Schema.NullOr(IssueActor),
  createdAt: IsoDateTime,
  /** What the event was about, where it has a subject: a label name, a login, a new title. */
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueEvent = typeof IssueEvent.Type;

/** A change request the tracker says closes or mentions this issue. */
export const IssueLinkedPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  /** Merging it closes this issue, rather than only citing it. */
  closesIssue: Schema.Boolean,
});
export type IssueLinkedPullRequest = typeof IssueLinkedPullRequest.Type;

/**
 * What a tracker can do at all, so a surface never offers an action that would fail. The
 * service refuses a call outside these before it reaches the driver.
 */
export const IssueCapabilities = Schema.Struct({
  create: Schema.Boolean,
  /** Title and body can be rewritten after filing. */
  edit: Schema.Boolean,
  comment: Schema.Boolean,
  labels: Schema.Boolean,
  assignees: Schema.Boolean,
  /** Reactions can be read and written on the issue and its comments. */
  reactions: Schema.Boolean,
  /** The scope offers starting points for a new issue. */
  templates: Schema.Boolean,
  /** The tracker reports linked change requests of its own accord. */
  linkedPullRequests: Schema.Boolean,
  /** State changes arrive as events beside the comments, not only as comments. */
  events: Schema.Boolean,
  /** The tracker narrows a listing by free text itself. */
  search: Schema.Boolean,
  /**
   * The states this tracker can be asked to move an issue into, by name. A git host offers
   * `open` and `closed`; a workflow tracker offers its own columns. Empty means state cannot be
   * changed from here.
   */
  states: Schema.Array(IssueState),
  /** Reasons a close can carry. Empty means a close takes none. */
  closeReasons: Schema.Array(TrimmedNonEmptyString),
});
export type IssueCapabilities = typeof IssueCapabilities.Type;

/**
 * What the signed-in account may do with this issue, which `capabilities` says nothing about.
 * A permission the tracker reports nothing about is granted, so a refusal comes from the
 * tracker, which says why, rather than from a missing control.
 */
export const IssueViewerPermissions = Schema.Struct({
  setState: Schema.Boolean,
  comment: Schema.Boolean,
  edit: Schema.Boolean,
  labels: Schema.Boolean,
  assignees: Schema.Boolean,
});
export type IssueViewerPermissions = typeof IssueViewerPermissions.Type;

export const IssueDetail = Schema.Struct({
  ...IssueSummary.fields,
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  /** False for an issue outside every project's scope, which is read-only through this server. */
  writable: Schema.Boolean,
  capabilities: IssueCapabilities,
  viewerPermissions: IssueViewerPermissions,
  /** The signed-in account, so a comment edit is offered only on the viewer's own remarks. */
  viewer: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
  reactions: Schema.optional(Schema.Array(IssueReaction)),
  comments: Schema.Array(IssueComment),
  /** Where older comments carry on; null once the conversation is whole. */
  commentsCursor: Schema.NullOr(TrimmedNonEmptyString),
  events: Schema.Array(IssueEvent),
  linkedPullRequests: Schema.Array(IssueLinkedPullRequest),
});
export type IssueDetail = typeof IssueDetail.Type;

/** Older comments, one page past a cursor the detail or a previous page handed over. */
export const IssueCommentsPageInput = Schema.Struct({
  ...IssueRef.fields,
  cursor: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type IssueCommentsPageInput = typeof IssueCommentsPageInput.Type;

export const IssueCommentsPage = Schema.Struct({
  comments: Schema.Array(IssueComment),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueCommentsPage = typeof IssueCommentsPage.Type;

/** Where each scope a listing already reached carries on, keyed `"<host> <scope>"`. */
export const IssueListCursors = Schema.Record(
  TrimmedNonEmptyString,
  TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
);
export type IssueListCursors = typeof IssueListCursors.Type;

export const IssueListInput = Schema.Struct({
  state: IssueListState,
  involvement: Schema.optional(IssueInvolvement),
  projectId: Schema.optional(ProjectId),
  /** Narrows to one host, named as the host itself. Absent means every host the workspace has. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Rows per scope, which with a continuation is rows per slice. */
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  /** Carry on from an earlier answer: only the scopes named here are read, one slice each. */
  cursors: Schema.optional(IssueListCursors),
  /** Free text the trackers themselves are asked to match. */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type IssueListInput = typeof IssueListInput.Type;

/** One tracker account the workspace has projects on, and whether it can be read right now. */
export const IssueTrackerSummary = Schema.Struct({
  tracker: IssueTrackerKind,
  host: TrimmedNonEmptyString,
  projectCount: PositiveInt,
  capabilities: Schema.NullOr(IssueCapabilities),
  /** False when the tracker's tool or credentials are missing, with `detail` saying which. */
  configured: Schema.Boolean,
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueTrackerSummary = typeof IssueTrackerSummary.Type;

export const IssueListProjectError = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type IssueListProjectError = typeof IssueListProjectError.Type;

export const IssueListResult = Schema.Struct({
  /** The signed-in account per host, which is what involvement compares against. */
  viewers: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  trackers: Schema.Array(IssueTrackerSummary),
  /** By update, newest first, across every scope this answer covers. */
  entries: Schema.Array(IssueListEntry),
  errors: Schema.Array(IssueListProjectError),
  /** Where each scope carries on, sent straight back as `cursors`. Absent once a scope is done. */
  nextCursors: IssueListCursors,
});
export type IssueListResult = typeof IssueListResult.Type;

const IssueTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
// Not trimmed: a body is markdown, where leading spaces open a code block. The bound keeps
// oversized payloads off the wire; the service rejects a comment that is only whitespace.
const IssueBody = Schema.String.check(Schema.isMaxLength(65_536));
const CommentBody = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536));

export const IssueCreateInput = Schema.Struct({
  ...IssueScopeRef.fields,
  title: IssueTitle,
  /** May be empty: an issue with a title and nothing else is a legitimate one. */
  body: IssueBody,
  labels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50)),
  assignees: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25)),
});
export type IssueCreateInput = typeof IssueCreateInput.Type;

export const IssueCreateResult = Schema.Struct({
  key: TrimmedNonEmptyString,
  displayKey: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type IssueCreateResult = typeof IssueCreateResult.Type;

export const IssueCommentInput = Schema.Struct({
  ...IssueRef.fields,
  body: CommentBody,
});
export type IssueCommentInput = typeof IssueCommentInput.Type;

/**
 * Rewrites the issue's own fields. Every field is optional and only the present ones are
 * written; `labels` and `assignees` are the whole set, which is how every tracker writes them.
 * The service refuses a request with nothing present.
 */
export const IssueUpdateInput = Schema.Struct({
  ...IssueRef.fields,
  title: Schema.optional(IssueTitle),
  body: Schema.optional(IssueBody),
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50))),
  assignees: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25))),
});
export type IssueUpdateInput = typeof IssueUpdateInput.Type;

/** Moves the issue to one of the states the tracker declared in `capabilities.states`. */
export const IssueSetStateInput = Schema.Struct({
  ...IssueRef.fields,
  state: TrimmedNonEmptyString,
  /** Only meaningful for a closing state on a tracker that declared `closeReasons`. */
  closeReason: Schema.optional(TrimmedNonEmptyString),
});
export type IssueSetStateInput = typeof IssueSetStateInput.Type;

export const IssueReactionInput = Schema.Struct({
  ...IssueRef.fields,
  /** Absent reacts to the issue itself; present names a comment id as the detail carried it. */
  subjectId: Schema.optional(TrimmedNonEmptyString),
  content: IssueReactionContent,
  reacted: Schema.Boolean,
});
export type IssueReactionInput = typeof IssueReactionInput.Type;

/**
 * One starting point a scope offers for a new issue. Only the body-shaped kind travels here:
 * GitHub's typed issue forms are flattened to a body by the driver, so a composer on any
 * tracker is one text box with a draft in it.
 */
export const IssueTemplate = Schema.Struct({
  key: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  about: Schema.String,
  title: Schema.String,
  body: Schema.String,
  labels: Schema.Array(TrimmedNonEmptyString),
  assignees: Schema.Array(TrimmedNonEmptyString),
});
export type IssueTemplate = typeof IssueTemplate.Type;

export const IssueTemplateList = Schema.Struct({
  templates: Schema.Array(IssueTemplate),
  /** False where the scope's config forbids an issue filed from nothing. */
  blankIssuesEnabled: Schema.Boolean,
});
export type IssueTemplateList = typeof IssueTemplateList.Type;

export const IssueLabelCandidate = Schema.Struct({
  ...IssueLabel.fields,
  description: Schema.NullOr(Schema.String),
});
export type IssueLabelCandidate = typeof IssueLabelCandidate.Type;

export const IssueAssigneeCandidate = Schema.Struct({
  ...IssueActor.fields,
  /** How the tracker addresses this person on a write, which is not always the login. */
  id: TrimmedNonEmptyString,
});
export type IssueAssigneeCandidate = typeof IssueAssigneeCandidate.Type;

/** The labels and people a scope offers, read when a picker opens rather than with every issue. */
export const IssueCandidates = Schema.Struct({
  labels: Schema.Array(IssueLabelCandidate),
  assignees: Schema.Array(IssueAssigneeCandidate),
  /** The tracker has more than were read, so somebody missing is not necessarily ineligible. */
  truncated: Schema.Boolean,
});
export type IssueCandidates = typeof IssueCandidates.Type;

export const IssueUnavailableReason = Schema.Literals([
  "tool-missing",
  "unauthenticated",
  "tracker-unsupported",
]);
export type IssueUnavailableReason = typeof IssueUnavailableReason.Type;

/** The tracker cannot be read at all for this project, as opposed to one request failing. */
export class IssueUnavailableError extends Schema.TaggedError<IssueUnavailableError>()(
  "IssueUnavailableError",
  {
    reason: IssueUnavailableReason,
    tracker: Schema.optional(IssueTrackerKind),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueUnavailableError)(this, { status: 503 });
  }

  override get message(): string {
    switch (this.reason) {
      case "tool-missing":
        return "The tool this tracker is read through is not installed or set up.";
      case "unauthenticated":
        return "This tracker has no working credentials.";
      case "tracker-unsupported":
        return "Issues cannot be browsed for this project yet.";
    }
  }
}

export class IssueOperationError extends Schema.TaggedError<IssueOperationError>()(
  "IssueOperationError",
  {
    operation: Schema.String,
    detail: TrimmedNonEmptyString,
    reason: Schema.optional(Schema.Literals(["not-found", "read-only", "rate-limited"])),
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 502 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(IssueOperationError)(this, { status: 502 });
  }

  override get message(): string {
    return `Issue operation ${this.operation} failed: ${this.detail}`;
  }
}

export type IssueError = IssueUnavailableError | IssueOperationError;

/** Who created a thread ↔ issue link. */
export const ThreadIssueLinkSource = Schema.Literals(["manual", "agent"]);
export type ThreadIssueLinkSource = typeof ThreadIssueLinkSource.Type;

/**
 * Identity of an issue as a thread link sees it: tracker-level, so the same issue linked through
 * two projects compares equal. `host` is always written here, unlike `IssueRef`, because a link
 * outlives the project whose binding supplied the default.
 */
export const ThreadIssueKey = Schema.Struct({
  tracker: IssueTrackerKind,
  host: TrimmedNonEmptyString,
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
});
export type ThreadIssueKey = typeof ThreadIssueKey.Type;

/** What a thread shows about a linked issue without a tracker read; null until first sync. */
export const ThreadIssueSnapshot = Schema.Struct({
  displayKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  state: IssueState,
  syncedAt: IsoDateTime,
});
export type ThreadIssueSnapshot = typeof ThreadIssueSnapshot.Type;

/**
 * An issue linked to a thread. `projectId` is the project the issue is read through, which the
 * refresh and the detail panel both need; `url` is what the agent or user handed over.
 */
export const ThreadIssueLink = Schema.Struct({
  ...ThreadIssueKey.fields,
  projectId: ProjectId,
  url: TrimmedNonEmptyString,
  source: ThreadIssueLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadIssueSnapshot),
});
export type ThreadIssueLink = typeof ThreadIssueLink.Type;

export function threadIssueKeyOf(key: ThreadIssueKey): string {
  return `${key.tracker}\u0000${key.host.trim().toLowerCase()}\u0000${key.scope.trim().toLowerCase()}\u0000${key.key.trim()}`;
}

export function threadIssueKeysEqual(left: ThreadIssueKey, right: ThreadIssueKey): boolean {
  return threadIssueKeyOf(left) === threadIssueKeyOf(right);
}

/** The `IssueRef` a link is read through. */
export function threadIssueRefOf(link: ThreadIssueLink): IssueRef {
  return {
    projectId: link.projectId,
    tracker: link.tracker,
    host: link.host,
    scope: link.scope,
    key: link.key,
  };
}
