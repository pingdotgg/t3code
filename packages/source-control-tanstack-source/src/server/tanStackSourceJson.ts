import {
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewThread,
  type PullRequestState,
} from "@t3tools/contracts";
import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
  ProviderChangeRequestStack,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { withoutOwnerMark } from "../shared/definition.ts";

/** Source sends times as epoch milliseconds. */
const EpochMillis = Schema.Finite;
const Login = Schema.String;

export const SourcePull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
  author: Schema.NullOr(Login),
  labels: Schema.optional(Schema.Array(Schema.String)),
  head: Schema.String,
  createdAt: EpochMillis,
  visibility: Schema.optional(Schema.String),
});
export type SourcePull = typeof SourcePull.Type;

export const SourcePulls = Schema.Struct({
  items: Schema.Array(SourcePull),
  next: Schema.NullOr(Schema.String),
});

const AutoMerge = Schema.Struct({ method: Schema.optional(Schema.String) });

export const SourcePullDetail = Schema.Struct({
  ...SourcePull.fields,
  body: Schema.NullOr(Schema.String),
  base: Schema.String,
  headRepo: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  baseSha: Schema.NullOr(Schema.String),
  mergeCommitSha: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(EpochMillis),
  mergedBy: Schema.NullOr(Login),
  mergeable: Schema.NullOr(Schema.Boolean),
  changedFiles: Schema.NullOr(Schema.Int),
  changedLines: Schema.optional(Schema.NullOr(Schema.Unknown)),
  reviewRequests: Schema.optional(Schema.Array(Login)),
  autoMerge: Schema.optional(Schema.NullOr(AutoMerge)),
  locked: Schema.optional(Schema.Boolean),
  htmlUrl: Schema.optional(Schema.String),
});
export type SourcePullDetail = typeof SourcePullDetail.Type;

/** `GET /pulls/{n}/checks`: the required checks of the base branch and whether it may merge. */
export const SourceMergeChecks = Schema.Struct({
  headSha: Schema.optional(Schema.NullOr(Schema.String)),
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      state: Schema.String,
      reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  upToDate: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mayMerge: Schema.Boolean,
  refusal: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SourceMergeChecks = typeof SourceMergeChecks.Type;

/** `GET /check-runs?sha=`: Source CI jobs (with a job id) and checks synced from GitHub (url). */
export const SourceCheckRun = Schema.Struct({
  jobId: Schema.optional(Schema.String),
  name: Schema.String,
  view: Schema.optional(Schema.String),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  startedAt: Schema.optional(Schema.NullOr(EpochMillis)),
  completedAt: Schema.optional(Schema.NullOr(EpochMillis)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  source: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SourceCheckRun = typeof SourceCheckRun.Type;
export const SourceCheckRuns = Schema.Array(SourceCheckRun);

export const SourceCiRuns = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      workflow: Schema.String,
      headSha: Schema.String,
      createdAt: EpochMillis,
      htmlUrl: Schema.String,
    }),
  ),
  next: Schema.NullOr(Schema.String),
});
export type SourceCiRun = (typeof SourceCiRuns.Type)["items"][number];

export const SourceCiRunDetail = Schema.Struct({
  id: Schema.String,
  jobs: Schema.Array(
    Schema.Struct({ key: Schema.String, name: Schema.String, jobId: Schema.NullOr(Schema.String) }),
  ),
});

/** The job of a run a check came from, which its log and re-run are addressed by. */
export interface SourceCiJob {
  readonly runId: string;
  readonly workflow: string;
  readonly key: string;
  readonly runUrl: string;
}

const TimelineEntry = Schema.Struct({
  id: Schema.Int,
  comment: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Login),
  at: EpochMillis,
  updatedAt: Schema.optional(Schema.NullOr(EpochMillis)),
  moderation: Schema.optional(Schema.String),
  review: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.String)),
  replyTo: Schema.optional(Schema.NullOr(Schema.Int)),
  reviewId: Schema.optional(Schema.NullOr(Schema.Int)),
});
type TimelineEntry = typeof TimelineEntry.Type;

export const SourceTimeline = Schema.Struct({
  // Events such as `head_updated` sit between the comments and carry no id.
  timeline: Schema.Array(Schema.Union([TimelineEntry, Schema.Struct({ event: Schema.String })])),
  next: Schema.NullOr(Schema.String),
});

const ThreadComment = Schema.Struct({
  id: Schema.Int,
  comment: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Login),
  at: EpochMillis,
  updatedAt: Schema.optional(Schema.NullOr(EpochMillis)),
});

export const SourceThreads = Schema.Array(
  Schema.Struct({
    id: Schema.Int,
    htmlUrl: Schema.optional(Schema.NullOr(Schema.String)),
    path: Schema.String,
    side: Schema.Literals(["old", "new"]),
    line: Schema.NullOr(Schema.Int),
    outdated: Schema.Boolean,
    resolved: Schema.Boolean,
    comments: Schema.Array(ThreadComment),
  }),
);

const CommitDetails = {
  baseSha: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  mergeBaseSha: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  unavailable: Schema.optional(Schema.NullOr(Schema.Unknown)),
  tooLarge: Schema.optional(Schema.NullOr(Schema.Unknown)),
};

export const SourceCommits = Schema.Struct({
  ...CommitDetails,
  commitsTruncated: Schema.NullOr(Schema.Boolean),
  commits: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        sha: Schema.String,
        title: Schema.String,
        author: Schema.Struct({ name: Schema.String, timestamp: Schema.Finite }),
      }),
    ),
  ),
});

export const SourceFiles = Schema.Struct({
  ...CommitDetails,
  truncated: Schema.NullOr(Schema.Boolean),
  files: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        oldPath: Schema.optional(Schema.NullOr(Schema.String)),
        status: Schema.String,
        binary: Schema.optional(Schema.Boolean),
        additions: Schema.optional(Schema.Int),
        deletions: Schema.optional(Schema.Int),
      }),
    ),
  ),
});
export type SourceFiles = typeof SourceFiles.Type;

export const SourceDiff = Schema.Struct({
  ...CommitDetails,
  truncated: Schema.NullOr(Schema.Boolean),
  patch: Schema.NullOr(Schema.String),
});

export const SourceContents = Schema.Struct({
  binary: Schema.Boolean,
  truncated: Schema.Boolean,
  content: Schema.NullOr(Schema.String),
});

export const SourceStack = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      headRef: Schema.String,
      baseRef: Schema.String,
      draft: Schema.Boolean,
    }),
  ),
});
export type SourceStack = typeof SourceStack.Type;

export const SourceLabels = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    color: Schema.NullOr(Schema.String),
    description: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

export const SourceUser = Schema.Struct({ username: Schema.String });

export const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export const pullUrl = (host: string, repository: string, number: number) =>
  `https://${host}/@${withoutOwnerMark(repository)}/pull/${number}`;

/**
 * A GitHub-synced pull request from a fork names its head only by its pull ref, and a private
 * one as `owner:branch`. A branch name holds no colon, so the owner is all that one can precede.
 */
export const headBranchName = (head: string) =>
  head.replace(/^refs\/heads\//u, "").replace(/^[^/:]+:/u, "");

/** Absent when Source names no visibility, so a reader tells unknown from public. */
const visibilityOf = (pull: Pick<SourcePull, "visibility">) =>
  pull.visibility === "private" || pull.visibility === "public"
    ? { visibility: pull.visibility }
    : {};

export function toActor(login: string | null, host: string): PullRequestActor | null {
  if (login === null || login.trim() === "") return null;
  return {
    login,
    name: null,
    avatarUrl: `https://${host}/avatars/${encodeURIComponent(login)}`,
    ...(login.endsWith("[bot]") ? { isBot: true } : {}),
  };
}

const toLabels = (labels: ReadonlyArray<string> | undefined) =>
  (labels ?? []).map((name) => ({ name, color: null }));

interface RepositoryOnHost {
  readonly repository: string;
  readonly host: string;
}

/** List rows name no base; the caller fills it from the detail read or the stack. */
export function toChangeRequest(
  pull: SourcePull & {
    readonly base?: string | undefined;
    readonly reviewRequests?: ReadonlyArray<string> | undefined;
  },
  target: RepositoryOnHost,
): ProviderChangeRequest {
  const createdAt = iso(pull.createdAt);
  return {
    number: pull.number,
    title: pull.title,
    url: pullUrl(target.host, target.repository, pull.number),
    author: toActor(pull.author, target.host),
    headBranch: headBranchName(pull.head),
    baseBranch: pull.base ?? "",
    state: pull.state,
    isDraft: pull.draft,
    ...visibilityOf(pull),
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt,
    // Source reports no update time; creation is the latest it can vouch for.
    updatedAt: createdAt,
    reviewRequestLogins: pull.reviewRequests ?? [],
    labels: toLabels(pull.labels),
  };
}

const COMPLETED_STATUS: Readonly<Record<string, PullRequestCheck["status"]>> = {
  success: "success",
  neutral: "neutral",
  skipped: "skipped",
  cancelled: "cancelled",
  action_required: "action-required",
  stale: "neutral",
};

function checkStatus(run: SourceCheckRun): PullRequestCheck["status"] {
  if (run.status !== "completed") return run.status === "waiting" ? "action-required" : "pending";
  return COMPLETED_STATUS[run.conclusion ?? ""] ?? "failure";
}

/** A Source CI job's page: its run, scrolled to the job. Also how its log is found again. */
const ciJobUrl = (job: SourceCiJob) => `${job.runUrl}?${new URLSearchParams({ job: job.key })}`;

/** The run and job a Source CI check's URL names. */
export function parseCiJobUrl(
  url: string | null,
  host: string,
): { readonly runId: string; readonly job: string } | null {
  const parsed = url === null ? null : URL.parse(url);
  if (parsed === null || parsed.hostname !== host) return null;
  const runId = /^\/@[^/]+\/[^/]+\/ci\/([0-9a-f-]{8,})\/?$/iu.exec(parsed.pathname)?.[1];
  const job = parsed.searchParams.get("job");
  return runId === undefined || job === null || job === "" ? null : { runId, job };
}

/**
 * Source lists every run of a commit's checks, so a re-run arrives beside the run it replaced.
 * The newest run of a name is the check's state; an older failure is history.
 */
export function toChecks(input: {
  readonly runs: ReadonlyArray<SourceCheckRun>;
  readonly jobs: ReadonlyMap<string, SourceCiJob>;
  readonly required: ReadonlySet<string>;
}): ReadonlyArray<PullRequestCheck> {
  const newest = new Map<string, { readonly run: SourceCheckRun; readonly at: number }>();
  for (const run of input.runs) {
    if (run.view === "superseded") continue;
    const job = run.jobId ? input.jobs.get(run.jobId) : undefined;
    const name = job === undefined ? run.name : `${job.workflow}/${run.name}`;
    const at = run.startedAt ?? run.completedAt ?? 0;
    const held = newest.get(name);
    if (held === undefined || at > held.at) newest.set(name, { run, at });
  }
  return sortChecks(
    [...newest.entries()].map(([name, { run }]) => {
      const job = run.jobId ? input.jobs.get(run.jobId) : undefined;
      return {
        name,
        status: checkStatus(run),
        description: run.summary?.split("\n", 1)[0]?.replace(/^#+\s*/u, "") || null,
        url: job === undefined ? (run.url ?? null) : ciJobUrl(job),
        ...(input.required.has(name) ? { required: true } : {}),
      };
    }),
  );
}

export function checksStateOf(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

const REVIEW_STATES: Readonly<Record<string, string>> = {
  approved: "approved",
  changes_requested: "changes_requested",
  commented: "commented",
};

const visible = (entry: { readonly moderation?: string | undefined }) =>
  entry.moderation === undefined || entry.moderation === "visible";

export function toActivity(input: {
  readonly timeline: typeof SourceTimeline.Type;
  readonly threads: typeof SourceThreads.Type;
  readonly commits: typeof SourceCommits.Type;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}): ProviderChangeRequestActivity {
  const { host } = input;
  const page = pullUrl(host, input.repository, input.number);
  const entries = input.timeline.timeline.filter(
    (entry): entry is TimelineEntry => "id" in entry && visible(entry),
  );
  const comments: Array<PullRequestComment> = entries.map((entry: TimelineEntry) => ({
    id: String(entry.id),
    kind:
      entry.review != null
        ? ("review" as const)
        : entry.path != null
          ? ("review-comment" as const)
          : ("issue-comment" as const),
    author: toActor(entry.author, host),
    body: entry.comment ?? "",
    createdAt: iso(entry.at),
    ...(entry.updatedAt != null && entry.updatedAt > entry.at
      ? { editedAt: iso(entry.updatedAt) }
      : {}),
    url: `${page}#comment-${entry.id}`,
    path: entry.path ?? null,
    reviewState: entry.review == null ? null : (REVIEW_STATES[entry.review] ?? entry.review),
  }));
  const reviewThreads = input.threads.flatMap((thread): ReadonlyArray<PullRequestReviewThread> => {
    if (thread.path.trim() === "" || thread.comments.length === 0) return [];
    return [
      {
        id: String(thread.id),
        path: thread.path,
        line: thread.line !== null && thread.line > 0 ? thread.line : null,
        side: thread.side === "old" ? "left" : "right",
        isResolved: thread.resolved,
        isOutdated: thread.outdated,
        comments: thread.comments.map((comment) => ({
          id: String(comment.id),
          author: toActor(comment.author, host),
          body: comment.comment ?? "",
          createdAt: iso(comment.at),
          ...(comment.updatedAt != null && comment.updatedAt > comment.at
            ? { editedAt: iso(comment.updatedAt) }
            : {}),
          url: `${page}#comment-${comment.id}`,
        })),
      },
    ];
  });
  return {
    comments,
    commentCount: comments.length,
    commentsTruncated: input.timeline.next !== null,
    reviewThreads,
    commits: (input.commits.commits ?? []).map((commit) => ({
      oid: commit.sha,
      messageHeadline: commit.title,
      committedDate: iso(commit.author.timestamp * 1_000),
    })),
  };
}

export function toStack(
  stack: SourceStack,
  target: RepositoryOnHost,
  states: ReadonlyMap<number, PullRequestState>,
): ProviderChangeRequestStack | null {
  const bottom = stack.members[0];
  if (bottom === undefined || stack.members.length < 2) return null;
  return {
    id: `${target.repository}#${bottom.number}`,
    number: bottom.number,
    url: pullUrl(target.host, target.repository, bottom.number),
    base: bottom.baseRef,
    layers: stack.members.map((member) => ({
      number: member.number,
      title: member.title,
      headBranch: headBranchName(member.headRef),
      state: states.get(member.number) ?? "open",
      isDraft: member.draft,
    })),
  };
}

/** The line comment a review draft names, as Source's review takes it. */
export function toReviewComment(draft: PullRequestReviewCommentDraft, commitId: string) {
  const line = (position: PullRequestReviewCommentDraft["position"]) =>
    position.kind === "added"
      ? { side: "new" as const, line: position.newLine }
      : position.kind === "deleted"
        ? { side: "old" as const, line: position.oldLine }
        : position.side === "left"
          ? { side: "old" as const, line: position.oldLine }
          : { side: "new" as const, line: position.newLine };
  const end = line(draft.position);
  const start = draft.startPosition === undefined ? undefined : line(draft.startPosition);
  return {
    path: draft.path,
    side: end.side,
    line: end.line,
    ...(start !== undefined && start.side === end.side && start.line < end.line
      ? { startLine: start.line }
      : {}),
    commitId,
    body: draft.body,
  };
}

/** The sections of a unified patch, by the path each one changes. */
export function patchSections(patch: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  const starts = [...patch.matchAll(/^diff --git a\/(.*) b\/(.*)$/gmu)];
  for (const [index, match] of starts.entries()) {
    const end = starts[index + 1]?.index ?? patch.length;
    const section = patch.slice(match.index, end);
    sections.set(match[2]!, section.endsWith("\n") ? section : `${section}\n`);
  }
  return sections;
}
