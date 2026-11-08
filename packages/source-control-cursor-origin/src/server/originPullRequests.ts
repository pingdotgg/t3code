/**
 * Origin's REST shapes, read leniently: the API is in beta and int64 fields arrive as strings.
 *
 * @module source-control-cursor-origin/server/originPullRequests
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  ChangeRequest,
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

const Int64 = Schema.Union([Schema.Number, Schema.NumberFromString]);
const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const OriginActorSchema = Schema.Struct({
  user: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: OptionalString,
        email: OptionalString,
        displayName: OptionalString,
        handle: OptionalString,
      }),
    ),
  ),
  app: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: OptionalString, displayName: OptionalString })),
  ),
  serviceAccount: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: OptionalString, displayName: OptionalString })),
  ),
});
type OriginActor = typeof OriginActorSchema.Type;

/** Cursor profile pictures by actor id. The REST API omits them; the CLI's JSON carries them. */
export type OriginAvatars = ReadonlyMap<string, string>;

/** The id an actor's avatar is keyed by, which the REST API and the CLI share. */
export function originActorId(actor: OriginActor | null | undefined): string | null {
  return (
    actor?.user?.id?.trim() || actor?.app?.id?.trim() || actor?.serviceAccount?.id?.trim() || null
  );
}

/** Every `{ id, avatarUrl }` pair anywhere in `origin pr list/view --json` output. */
export function originAvatars(json: unknown): Map<string, string> {
  const avatars = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.avatarUrl === "string")
      avatars.set(record.id, record.avatarUrl.trim());
    for (const child of Object.values(record)) visit(child);
  };
  visit(json);
  return avatars;
}

const RefSchema = Schema.Struct({ ref: Schema.String, sha: OptionalString });

export const OriginPullRequestSchema = Schema.Struct({
  number: Int64,
  state: OptionalString,
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  title: Schema.String,
  body: OptionalString,
  head: RefSchema,
  base: RefSchema,
  author: Schema.optional(Schema.NullOr(OriginActorSchema)),
  createdAt: OptionalString,
  updatedAt: OptionalString,
  closedAt: OptionalString,
  mergedAt: OptionalString,
  additions: Schema.optional(Schema.NullOr(Int64)),
  deletions: Schema.optional(Schema.NullOr(Int64)),
  changedFiles: Schema.optional(Schema.NullOr(Int64)),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({ name: Schema.String, color: OptionalString, description: OptionalString }),
      ),
    ),
  ),
  webUrl: Schema.String,
  stack: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        parentPullRequest: Schema.optional(Schema.NullOr(Schema.Struct({ number: Int64 }))),
      }),
    ),
  ),
  version: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        headSha: OptionalString,
        baseSha: OptionalString,
        potentialMergeCommit: Schema.optional(
          Schema.NullOr(Schema.Struct({ state: OptionalString, baseSha: OptionalString })),
        ),
      }),
    ),
  ),
});
export type OriginPullRequest = typeof OriginPullRequestSchema.Type;

export const OriginPullRequestListSchema = Schema.Struct({
  pullRequests: Schema.optional(Schema.NullOr(Schema.Array(OriginPullRequestSchema))),
  nextPageToken: OptionalString,
});

export const OriginRepositorySchema = Schema.Struct({
  name: Schema.String,
  fullName: OptionalString,
  owner: Schema.optional(Schema.NullOr(Schema.Struct({ slug: Schema.String }))),
  defaultBranch: OptionalString,
  cloneUrl: OptionalString,
  allowMergeCommit: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allowSquashMerge: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type OriginRepository = typeof OriginRepositorySchema.Type;

const ThreadSchema = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.Struct({ headSha: OptionalString }))),
  path: OptionalString,
  side: OptionalString,
  startLine: Schema.optional(Schema.NullOr(Int64)),
  endLine: Schema.optional(Schema.NullOr(Int64)),
  resolvedAt: OptionalString,
});

const OriginCommentSchema = Schema.Struct({
  id: Schema.String,
  thread: Schema.optional(Schema.NullOr(ThreadSchema)),
  body: OptionalString,
  author: Schema.optional(Schema.NullOr(OriginActorSchema)),
  createdAt: Schema.String,
  updatedAt: OptionalString,
});
export type OriginComment = typeof OriginCommentSchema.Type;

export const OriginCommentListSchema = Schema.Struct({
  comments: Schema.optional(Schema.NullOr(Schema.Array(OriginCommentSchema))),
  nextPageToken: OptionalString,
});

export const OriginReviewListSchema = Schema.Struct({
  reviews: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          author: Schema.optional(Schema.NullOr(OriginActorSchema)),
          verdict: OptionalString,
          body: OptionalString,
          submittedAt: Schema.String,
          dismissal: Schema.optional(Schema.NullOr(Schema.Struct({ dismissedAt: OptionalString }))),
        }),
      ),
    ),
  ),
  nextPageToken: OptionalString,
});

const CommitPersonSchema = Schema.Struct({ date: OptionalString });

export const OriginCommitListSchema = Schema.Struct({
  commits: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          sha: Schema.String,
          commit: Schema.Struct({
            author: Schema.optional(Schema.NullOr(CommitPersonSchema)),
            committer: Schema.optional(Schema.NullOr(CommitPersonSchema)),
            message: Schema.String,
          }),
          stats: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                additions: Schema.optional(Schema.NullOr(Int64)),
                deletions: Schema.optional(Schema.NullOr(Int64)),
              }),
            ),
          ),
        }),
      ),
    ),
  ),
  nextPageToken: OptionalString,
});

export const OriginFileListSchema = Schema.Struct({
  files: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          filename: Schema.String,
          status: OptionalString,
          patch: OptionalString,
          previousFilename: OptionalString,
        }),
      ),
    ),
  ),
  nextPageToken: OptionalString,
});

export const OriginCheckRunListSchema = Schema.Struct({
  checkRuns: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          status: OptionalString,
          conclusion: OptionalString,
          detailsUrl: OptionalString,
          output: Schema.optional(Schema.NullOr(Schema.Struct({ title: OptionalString }))),
        }),
      ),
    ),
  ),
  nextPageToken: OptionalString,
});

export function originActor(
  actor: OriginActor | null | undefined,
  avatars?: OriginAvatars,
): PullRequestActor | null {
  if (!actor) return null;
  const id = originActorId(actor);
  const avatarUrl = (id && avatars?.get(id)) || null;
  const user = actor.user;
  const login = user?.handle?.trim() || user?.email?.trim() || user?.displayName?.trim();
  if (login) return { login, name: user?.displayName ?? null, avatarUrl };
  const bot = actor.app ?? actor.serviceAccount;
  const name = bot?.displayName?.trim() || bot?.id?.trim();
  return name ? { login: name, name, avatarUrl, isBot: true } : null;
}

/**
 * Whether the head merges cleanly into the base, from the merge commit Origin prepared for the
 * pull request's latest version. That merge was made against the base as it stood then, so it
 * only answers for the base's current tip when the version was built on it.
 */
export function preparedMergeability(pullRequest: OriginPullRequest): PullRequestMergeability {
  // A version still being built for a new head answers for the old one.
  if (!pullRequest.head.sha || pullRequest.version?.headSha !== pullRequest.head.sha)
    return "unknown";
  const state = pullRequest.version?.potentialMergeCommit?.state;
  return state === "prepared"
    ? "mergeable"
    : state === "merge_conflict"
      ? "conflicting"
      : "unknown";
}

export const OriginMergeabilitySchema = Schema.Struct({
  verdict: OptionalString,
  headSha: OptionalString,
  blockers: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ kind: OptionalString })))),
});

export const OriginGitRefSchema = Schema.Struct({
  object: Schema.optional(Schema.NullOr(Schema.Struct({ sha: OptionalString }))),
});

export function originState(pullRequest: OriginPullRequest): PullRequestState {
  if (pullRequest.merged || pullRequest.mergedAt || pullRequest.state === "merged") return "merged";
  return pullRequest.state === "closed" ? "closed" : "open";
}

/** Stands in for a time Origin left out, so a row still sorts and renders. */
export const UNKNOWN_TIME = "1970-01-01T00:00:00.000Z";

const timestamp = (value: string | null | undefined) => value?.trim() || null;

export function originUpdatedAt(pullRequest: OriginPullRequest): string {
  return timestamp(pullRequest.updatedAt) ?? timestamp(pullRequest.createdAt) ?? UNKNOWN_TIME;
}

export function toOriginChangeRequest(pullRequest: OriginPullRequest): ChangeRequest {
  const updatedAt = timestamp(pullRequest.updatedAt);
  return {
    provider: SourceControlProviderKind.make("cursor-origin"),
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.webUrl,
    baseRefName: pullRequest.base.ref,
    headRefName: pullRequest.head.ref,
    ...(pullRequest.head.sha ? { headSha: pullRequest.head.sha } : {}),
    state: originState(pullRequest),
    ...(pullRequest.draft ? { isDraft: true } : {}),
    closedAt: timestamp(pullRequest.closedAt),
    mergedAt: timestamp(pullRequest.mergedAt),
    updatedAt:
      updatedAt === null ? Option.none() : Option.map(DateTime.make(updatedAt), DateTime.toUtc),
  };
}

export function originCheck(
  run: NonNullable<(typeof OriginCheckRunListSchema.Type)["checkRuns"]>[number],
): PullRequestCheck {
  const status: PullRequestCheckStatus =
    run.status !== "completed"
      ? run.status === "failing"
        ? "failure"
        : "pending"
      : run.conclusion === "success"
        ? "success"
        : run.conclusion === "skipped"
          ? "skipped"
          : run.conclusion === "neutral" || run.conclusion === "stale"
            ? "neutral"
            : run.conclusion === "cancelled"
              ? "cancelled"
              : run.conclusion === "action_required"
                ? "action-required"
                : "failure";
  return {
    name: run.name,
    status,
    description: run.output?.title ?? null,
    url: run.detailsUrl ?? null,
  };
}

export function checksState(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  if (
    checks.some(
      (check) =>
        check.status === "failure" ||
        check.status === "cancelled" ||
        check.status === "action-required",
    )
  )
    return "failing";
  if (checks.some((check) => check.status === "pending")) return "pending";
  return "passing";
}

/** A unified patch for the files a pull request or commit touches, from GitHub-style hunks. */
export function originFilesPatch(
  files: NonNullable<(typeof OriginFileListSchema.Type)["files"]>,
): string {
  return files
    .map((file) => {
      const oldPath = file.previousFilename || file.filename;
      const added = file.status === "added";
      const removed = file.status === "removed" || file.status === "deleted";
      const action = file.status === "copied" ? "copy" : "rename";
      const before = quoteGitPatchPath(`a/${oldPath}`);
      const after = quoteGitPatchPath(`b/${file.filename}`);
      const header = [
        `diff --git ${before} ${after}`,
        ...(added ? ["new file mode 100644"] : removed ? ["deleted file mode 100644"] : []),
        ...(oldPath !== file.filename
          ? [
              `similarity index ${file.patch ? 0 : 100}%`,
              `${action} from ${quoteGitPatchPath(oldPath)}`,
              `${action} to ${quoteGitPatchPath(file.filename)}`,
            ]
          : []),
      ];
      if (!file.patch) return `${header.join("\n")}\n`;
      return [
        ...header,
        `--- ${added ? "/dev/null" : before}`,
        `+++ ${removed ? "/dev/null" : after}`,
        file.patch.endsWith("\n") ? file.patch.slice(0, -1) : file.patch,
      ]
        .join("\n")
        .concat("\n");
    })
    .join("");
}
