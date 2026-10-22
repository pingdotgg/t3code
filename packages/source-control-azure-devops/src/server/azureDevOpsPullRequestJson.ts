import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActivityEvent,
  PullRequestUpdate,
  PullRequestActor,
  PullRequestReviewer,
  PullRequestCommit,
  PullRequestReviewThread,
  PullRequestComment,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import { PullRequestThreadStatus, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { azureDevOpsPullRequestWebUrl } from "./azureDevOpsPullRequests.ts";

/**
 * Azure's enums are decoded as plain strings and normalized here, in the same tolerant style as
 * the other hosts: a new merge status must not fail a whole payload. Every field beyond the
 * identity is optional, because `az repos pr` returns rather more or less of the REST object
 * depending on the command.
 */
const RawIdentitySchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  uniqueName: Schema.optional(Schema.NullOr(Schema.String)),
  imageUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestSchema = Schema.Struct({
  pullRequestId: Schema.Int,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  /**
   * Who armed auto-complete, which is the only thing Azure says about it: the field carries an
   * identity while the pull request is set to complete on its own, and Azure leaves it out
   * entirely once nobody has. So its presence is the answer, and there is no third state.
   */
  autoCompleteSetBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  completionOptions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        mergeStrategy: Schema.optional(Schema.NullOr(Schema.String)),
        squashMerge: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  lastMergeSourceCommit: Schema.optional(Schema.NullOr(Schema.Struct({ commitId: Schema.String }))),
  mergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  reviewers: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          ...RawIdentitySchema.fields,
          vote: Schema.optional(Schema.NullOr(Schema.Int)),
        }),
      ),
    ),
  ),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String })))),
  // Required, and required to be non-empty: the wire contract will not carry a change request
  // without a branch or a created time, so a row missing one is skipped rather than breaking the
  // response it travels in.
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  creationDate: TrimmedNonEmptyString,
  closedDate: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        webUrl: Schema.optional(Schema.NullOr(Schema.String)),
        project: Schema.optional(
          Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
      }),
    ),
  ),
  _links: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        web: Schema.optional(
          Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});

/** A pull request thread, which is how Azure keeps its conversation. */
const Position = Schema.NullOr(Schema.Struct({ line: Schema.Int }));
const RawThreadSchema = Schema.Struct({
  identities: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, RawIdentitySchema))),
  properties: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  pullRequestThreadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        iterationContext: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              firstComparingIteration: Schema.Int,
              secondComparingIteration: Schema.Int,
            }),
          ),
        ),
        trackingCriteria: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              origFilePath: Schema.optional(Schema.NullOr(Schema.String)),
              origLeftFileStart: Schema.optional(Position),
              origLeftFileEnd: Schema.optional(Position),
              origRightFileStart: Schema.optional(Position),
              origRightFileEnd: Schema.optional(Position),
            }),
          ),
        ),
      }),
    ),
  ),
  id: Schema.Int,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  threadContext: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        filePath: Schema.optional(Schema.NullOr(Schema.String)),
        leftFileEnd: Schema.optional(Position),
        rightFileEnd: Schema.optional(Position),
        leftFileStart: Schema.optional(Position),
        rightFileStart: Schema.optional(Schema.NullOr(Schema.Struct({ line: Schema.Int }))),
      }),
    ),
  ),
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.NullOr(Schema.Int)),
          parentCommentId: Schema.optional(Schema.NullOr(Schema.Int)),
          content: Schema.optional(Schema.NullOr(Schema.String)),
          author: Schema.optional(Schema.NullOr(RawIdentitySchema)),
          publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
          lastContentUpdatedDate: Schema.optional(Schema.NullOr(Schema.String)),
          usersLiked: Schema.optional(Schema.NullOr(Schema.Array(RawIdentitySchema))),
          isDeleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
          commentType: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});

const isThreadStatus = Schema.is(PullRequestThreadStatus);

const RawThreadPageSchema = Schema.Struct({
  value: Schema.Array(Schema.Unknown),
});

export interface AzureDevOpsRepositoryLocation {
  readonly project: string;
  readonly repository: string;
}

export interface AzureDevOpsPullRequest {
  readonly identities?: Readonly<Record<string, string>>;
  readonly labels?: ReadonlyArray<{ readonly name: string; readonly color: string | null }>;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headSha?: string;
  readonly closedAt: string | null;
  readonly body: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestReviewer>;
  readonly location: AzureDevOpsRepositoryLocation | null;
  readonly autoMergeEnabled: boolean;
  readonly autoMergeMethod?: PullRequestMergeMethod;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function normalizeRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

/** A login has to compare against `az account show`, which reports an email. */
function toActor(raw: Schema.Schema.Type<typeof RawIdentitySchema> | null | undefined) {
  const login = trimmed(raw?.uniqueName) ?? trimmed(raw?.displayName);
  return login === null
    ? null
    : { login, name: trimmed(raw?.displayName), avatarUrl: trimmed(raw?.imageUrl) };
}

function toState(raw: Schema.Schema.Type<typeof RawPullRequestSchema>): PullRequestState {
  switch (raw.status?.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    case "conflicts":
    case "failure":
    case "rejectedbypolicy":
      return "conflicting";
    default:
      return "unknown";
  }
}

function toLocation(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsRepositoryLocation | null {
  const project = trimmed(raw.repository?.project?.name);
  const repository = trimmed(raw.repository?.name);
  if (project === null || repository === null) return null;
  return { project, repository };
}

function toAutoMergeMethod(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): PullRequestMergeMethod | undefined {
  if (raw.autoCompleteSetBy == null) return undefined;
  switch (raw.completionOptions?.mergeStrategy?.trim().toLowerCase()) {
    case "squash":
      return "squash";
    case "rebase":
    case "rebasemerge":
      return "rebase";
    case "nofastforward":
      return "merge";
    default:
      return raw.completionOptions?.squashMerge === true ? "squash" : undefined;
  }
}

function toPullRequest(
  raw: Schema.Schema.Type<typeof RawPullRequestSchema>,
): AzureDevOpsPullRequest | null {
  const autoMergeMethod = toAutoMergeMethod(raw);
  const reviewers = (raw.reviewers ?? []).flatMap((reviewer): PullRequestReviewer[] => {
    const actor = toActor(reviewer);
    const reviewState =
      reviewer.vote === 10
        ? "approved"
        : reviewer.vote === 5
          ? "approved-with-suggestions"
          : reviewer.vote === 0
            ? "none"
            : reviewer.vote === -5
              ? "waiting-for-author"
              : reviewer.vote === -10
                ? "rejected"
                : undefined;
    return actor === null
      ? []
      : [{ ...actor, ...(reviewState === undefined ? {} : { reviewState }) }];
  });
  const closedAt = trimmed(raw.closedDate);
  const url = trimmed(
    azureDevOpsPullRequestWebUrl({
      pullRequestId: raw.pullRequestId,
      webLink: raw._links?.web?.href,
      repositoryWebUrl: raw.repository?.webUrl,
      restApiUrl: raw.url,
      projectName: raw.repository?.project?.name,
      repositoryName: raw.repository?.name,
    }),
  );
  const headBranch = trimmed(normalizeRefName(raw.sourceRefName));
  const baseBranch = trimmed(normalizeRefName(raw.targetRefName));
  if (url === null || headBranch === null || baseBranch === null) return null;
  const identities = Object.fromEntries(
    [raw.createdBy, ...(raw.reviewers ?? [])].flatMap((person) =>
      person?.id
        ? [[person.id.toLowerCase(), person.displayName ?? person.uniqueName ?? person.id]]
        : [],
    ),
  );
  return {
    ...(Object.keys(identities).length ? { identities } : {}),
    labels: (raw.labels ?? []).map((label) => ({ name: label.name, color: null })),
    number: raw.pullRequestId,
    title: raw.title,
    url,
    author: toActor(raw.createdBy),
    headBranch,
    baseBranch,
    state: toState(raw),
    isDraft: raw.isDraft ?? false,
    mergeability: toMergeability(raw.mergeStatus),
    createdAt: raw.creationDate,
    updatedAt: closedAt ?? raw.creationDate,
    ...(raw.lastMergeSourceCommit?.commitId ? { headSha: raw.lastMergeSourceCommit.commitId } : {}),
    closedAt,
    body: raw.description ?? "",
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    location: toLocation(raw),
    autoMergeEnabled: (raw.autoCompleteSetBy ?? null) !== null,
    ...(autoMergeMethod === undefined ? {} : { autoMergeMethod }),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodePullRequestEntry = Schema.decodeUnknownExit(RawPullRequestSchema);
const decodePullRequest = decodeJsonResult(RawPullRequestSchema);
const decodeThreadPage = decodeJsonResult(RawThreadPageSchema);
const decodeThreadEntry = Schema.decodeUnknownExit(RawThreadSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface AzureDevOpsPullRequestBatch {
  readonly items: ReadonlyArray<AzureDevOpsPullRequest>;
  readonly rawIndexes: ReadonlyArray<number>;
  /** Rows Azure returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

export function decodePullRequestListJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequestBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: AzureDevOpsPullRequest[] = [];
  const rawIndexes: number[] = [];
  for (const [rawIndex, entry] of decoded.success.entries()) {
    const item = decodePullRequestEntry(entry);
    if (Exit.isFailure(item)) continue;
    const pullRequest = toPullRequest(item.value);
    if (pullRequest !== null) {
      items.push(pullRequest);
      rawIndexes.push(rawIndex);
    }
  }
  return Result.succeed({ items, rawIndexes, rawCount: decoded.success.length });
}

/** Null carries "Azure answered, but with too little to use", which the caller reports. */
export function decodePullRequestJson(
  raw: string,
): Result.Result<AzureDevOpsPullRequest | null, DecodeFailure> {
  const decoded = decodePullRequest(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toPullRequest(decoded.success))
    : Result.fail(decoded.failure);
}

export function decodeThreadsJson(
  raw: string,
  viewer?: string,
): Result.Result<ReadonlyArray<PullRequestComment>, DecodeFailure> {
  const decoded = decodeThreadPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments: PullRequestComment[] = [];
  for (const entry of decoded.success.value) {
    const decodedThread = decodeThreadEntry(entry);
    if (Exit.isFailure(decodedThread)) continue;
    const thread = decodedThread.value;
    if (thread.isDeleted === true) continue;
    const path = trimmed(thread.threadContext?.filePath);
    for (const comment of thread.comments ?? []) {
      const publishedDate = trimmed(comment.publishedDate);
      if (
        comment.isDeleted === true ||
        comment.commentType?.trim().toLowerCase() === "system" ||
        (comment.content ?? "").trim().length === 0 ||
        publishedDate === null
      ) {
        continue;
      }
      const likedBy = [
        ...new Set(
          (comment.usersLiked ?? []).map(toActor).flatMap((actor) => (actor ? [actor.login] : [])),
        ),
      ];
      const viewerHasReacted =
        viewer !== undefined &&
        likedBy.some((login) => login.toLowerCase() === viewer.toLowerCase());
      comments.push({
        ...(viewer === undefined && likedBy.length === 0
          ? {}
          : {
              reactions:
                likedBy.length === 0
                  ? []
                  : [
                      {
                        content: "thumbs-up" as const,
                        count: likedBy.length,
                        viewerHasReacted,
                        actors: likedBy.filter(
                          (login) =>
                            !viewerHasReacted || login.toLowerCase() !== viewer?.toLowerCase(),
                        ),
                      },
                    ],
            }),
        id: `${thread.id}:${comment.id ?? 0}`,
        threadId: String(thread.id),
        ...(isThreadStatus(thread.status) ? { threadStatus: thread.status } : {}),
        editedAt:
          trimmed(comment.lastContentUpdatedDate) !== publishedDate
            ? trimmed(comment.lastContentUpdatedDate)
            : null,
        ...(comment.parentCommentId != null && comment.parentCommentId > 0
          ? { replyToCommentId: `${thread.id}:${comment.parentCommentId}` }
          : {}),
        kind: path === null ? "issue-comment" : "review-comment",
        author: toActor(comment.author),
        body: comment.content ?? "",
        createdAt: publishedDate,
        url: null,
        path,
        reviewState: null,
      });
    }
  }
  return Result.succeed(
    comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  );
}

const decodeThreadProperty = Schema.decodeUnknownExit(
  Schema.Struct({ $value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]) }),
);

function systemActivity(
  thread: typeof RawThreadSchema.Type,
  author: typeof RawIdentitySchema.Type | null | undefined,
  content: string,
): Pick<PullRequestActivityEvent, "actor" | "body" | "kind"> {
  const property = (key: string) => {
    const decoded = decodeThreadProperty(thread.properties?.[key]);
    return Exit.isSuccess(decoded) ? String(decoded.value.$value) : undefined;
  };
  const identity = (key: string) => thread.identities?.[property(key) ?? ""];
  const event = (
    kind: PullRequestActivityEvent["kind"],
    action: string,
    actor: PullRequestActor | null,
  ) => ({ kind, actor, body: `${actor?.name ?? actor?.login ?? "Someone"} ${action}` });
  const actorFor = (prefix: string) => {
    const actor = toActor(identity(`${prefix}Identity`));
    if (actor) return actor;
    const name = property(`${prefix}DisplayName`);
    return name ? { name, login: property(prefix) ?? name, avatarUrl: null } : toActor(author);
  };

  switch (property("CodeReviewThreadType")) {
    case "VoteUpdate": {
      const actor = actorFor("CodeReviewVotedBy");
      switch (property("CodeReviewVoteResult")) {
        case "10":
          return event("approved", "approved the pull request", actor);
        case "5":
          return event("approved", "approved the pull request with suggestions", actor);
        case "0":
          return event("review", "reset their vote", actor);
        case "-5":
          return event("review", "is waiting for the author", actor);
        case "-10":
          return event("changes-requested", "rejected the pull request", actor);
      }
      break;
    }
    case "RefUpdate": {
      const count = property("CodeReviewRefNewCommitsCount");
      const branch = property("CodeReviewRefName")?.replace(/^refs\/heads\//, "");
      const actor = actorFor("CodeReviewRefUpdatedBy");
      if (count && /^\d+$/.test(count) && Number(count) > 0)
        return event("push", `pushed ${count} commit${count === "1" ? "" : "s"}`, actor);
      if (branch) return event("push", `updated ${branch}`, actor);
      break;
    }
    case "StatusUpdate": {
      const actor = actorFor("CodeReviewStatusUpdatedBy");
      switch (property("CodeReviewStatus")?.toLowerCase()) {
        case "completed":
          return event("merged", "completed the pull request", actor);
        case "abandoned":
          return event("closed", "abandoned the pull request", actor);
        case "active":
          return event("reopened", "reactivated the pull request", actor);
      }
      break;
    }
    case "PolicyStatusUpdate": {
      const reviewers = decodeJsonResult(Schema.Array(Schema.String))(
        property("CodeReviewRequiredReviewerExampleReviewerIdentities") ?? "null",
      );
      if (Result.isSuccess(reviewers) && reviewers.success.length > 0) {
        const names = reviewers.success.map((id) => {
          const reviewer = thread.identities?.[id];
          return reviewer?.displayName ?? reviewer?.uniqueName;
        });
        if (names.every((name): name is string => typeof name === "string" && name.length > 0))
          return {
            kind: "reviewers",
            actor: toActor(author),
            body: `${new Intl.ListFormat("en").format(names)} ${names.length === 1 ? "was added as a reviewer" : "were added as reviewers"}.`,
          };
      }
      break;
    }
    case "ReviewersUpdate":
      return {
        kind: "reviewers",
        actor: toActor(identity("CodeReviewReviewersUpdatedByIdentity")) ?? toActor(author),
        body: content,
      };
  }
  return { actor: toActor(author), body: content };
}

export function decodeDiscussionJson(
  raw: string,
  viewer?: string,
  iterationId?: number,
): Result.Result<
  {
    comments: ReadonlyArray<PullRequestComment>;
    reviewThreads: ReadonlyArray<PullRequestReviewThread>;
    events: ReadonlyArray<PullRequestActivityEvent>;
    identities: Readonly<Record<string, string>>;
    untrackedThreadIds?: ReadonlyArray<string>;
  },
  DecodeFailure
> {
  const page = decodeThreadPage(raw);
  const comments = decodeThreadsJson(raw, viewer);
  if (Result.isFailure(page)) return Result.fail(page.failure);
  if (Result.isFailure(comments)) return Result.fail(comments.failure);
  const commentsByThread = new Map<string, PullRequestComment[]>();
  for (const comment of comments.success) {
    if (comment.threadId === undefined) continue;
    const held = commentsByThread.get(comment.threadId);
    if (held) held.push(comment);
    else commentsByThread.set(comment.threadId, [comment]);
  }
  const reviewThreads: PullRequestReviewThread[] = [];
  const untrackedThreadIds: string[] = [];
  const events: PullRequestActivityEvent[] = [];
  const identities: Record<string, string> = {};
  for (const entry of page.success.value) {
    const decoded = decodeThreadEntry(entry);
    if (Exit.isFailure(decoded) || decoded.value.isDeleted) continue;
    const thread = decoded.value;
    for (const identity of [
      ...Object.values(thread.identities ?? {}),
      ...(thread.comments ?? []).flatMap((comment) => (comment.author ? [comment.author] : [])),
    ]) {
      if (identity.id)
        identities[identity.id.toLowerCase()] =
          identity.displayName ?? identity.uniqueName ?? identity.id;
    }
    for (const comment of thread.comments ?? []) {
      if (
        comment.commentType?.trim().toLowerCase() !== "system" ||
        comment.isDeleted ||
        !comment.content ||
        !comment.publishedDate
      )
        continue;
      events.push({
        id: `azure-event:${thread.id}:${comment.id}`,
        createdAt: comment.publishedDate,
        ...systemActivity(thread, comment.author, comment.content),
      });
    }
    const path = trimmed(thread.threadContext?.filePath)?.replace(/^\//, "");
    if (!path) continue;
    const remarks = commentsByThread.get(String(thread.id)) ?? [];
    if (remarks.length === 0) continue;
    const right = thread.threadContext?.rightFileStart?.line;
    const left = thread.threadContext?.leftFileStart?.line;
    const original = thread.pullRequestThreadContext?.trackingCriteria;
    const originalUpdate =
      thread.pullRequestThreadContext?.iterationContext?.secondComparingIteration;
    const start = right ?? left;
    const untracked =
      start !== undefined &&
      originalUpdate !== undefined &&
      iterationId !== undefined &&
      originalUpdate < iterationId &&
      !original;
    const end =
      right !== undefined
        ? thread.threadContext?.rightFileEnd?.line
        : thread.threadContext?.leftFileEnd?.line;
    const originalStart =
      right !== undefined ? original?.origRightFileStart?.line : original?.origLeftFileStart?.line;
    const originalEnd =
      right !== undefined ? original?.origRightFileEnd?.line : original?.origLeftFileEnd?.line;
    if (untracked) untrackedThreadIds.push(String(thread.id));
    reviewThreads.push({
      ...(original?.origFilePath
        ? { originalPath: original.origFilePath.replace(/^\//, "") }
        : untracked
          ? { originalPath: path, originalLine: start > 0 ? start : null }
          : {}),
      ...(originalStart !== undefined
        ? { originalLine: originalStart > 0 ? originalStart : null }
        : {}),
      ...(originalEnd !== undefined
        ? { originalEndLine: originalEnd > 0 ? originalEnd : null }
        : {}),
      ...(originalUpdate && originalUpdate > 0 ? { originalUpdate } : {}),
      ...(end !== undefined ? { endLine: end > 0 ? end : null } : {}),
      id: String(thread.id),
      path,
      line: start !== undefined && start > 0 ? start : null,
      side: right !== undefined ? "right" : "left",
      isResolved: ["fixed", "wontFix", "closed", "byDesign"].includes(thread.status ?? ""),
      isOutdated: start !== undefined && start <= 0,
      comments: remarks.map((comment) => ({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
        editedAt: comment.editedAt,
        url: comment.url,
        ...(comment.reactions === undefined ? {} : { reactions: comment.reactions }),
      })),
    });
  }
  return Result.succeed({
    comments: comments.success,
    reviewThreads,
    events,
    identities,
    ...(untrackedThreadIds.length ? { untrackedThreadIds } : {}),
  });
}
const RawCommit = Schema.Struct({
  commitId: TrimmedNonEmptyString,
  comment: Schema.optional(Schema.NullOr(Schema.String)),
  parents: Schema.optional(Schema.Array(Schema.String)),
  author: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      date: Schema.String,
    }),
  ),
  committer: Schema.optional(Schema.Struct({ date: Schema.String })),
});
const decodeCommitPage = decodeJsonResult(Schema.Struct({ value: Schema.Array(RawCommit) }));
export const decodeCommitJson = decodeJsonResult(RawCommit);
export function decodeCommitsJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestCommit>, DecodeFailure> {
  const page = decodeCommitPage(raw);
  if (Result.isFailure(page)) return Result.fail(page.failure);
  return Result.succeed(
    page.success.value.flatMap((commit) => {
      const date = commit.committer?.date ?? commit.author?.date;
      return date
        ? [
            {
              oid: commit.commitId,
              messageHeadline: (commit.comment ?? "").split("\n")[0]!,
              committedDate: date,
              authors: commit.author
                ? [
                    {
                      login: commit.author.email ?? commit.author.name ?? "unknown",
                      name: commit.author.name ?? null,
                      avatarUrl: null,
                    },
                  ]
                : [],
            },
          ]
        : [];
    }),
  );
}
const decodeCommitChanges = decodeJsonResult(
  Schema.Struct({ changes: Schema.Array(Schema.Unknown), allChangesIncluded: Schema.Boolean }),
);
const encodeCommitChanges = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export function decodeCommitChangesJson(
  raw: string,
): Result.Result<
  { changes: ReadonlyArray<AzureDevOpsChangeEntry>; truncated: boolean },
  DecodeFailure
> {
  const page = decodeCommitChanges(raw);
  if (Result.isFailure(page)) return Result.fail(page.failure);
  const decoded = decodeIterationChangesJson(
    encodeCommitChanges({ changeEntries: page.success.changes }),
  );
  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure)
    : Result.succeed({
        changes: decoded.success.changes,
        truncated: !page.success.allChangesIncluded,
      });
}

/**
 * One push's worth of a pull request. Azure records every push as an iteration and keys the whole
 * review off them: the changed files, and the marks a reader leaves on those files, both hang
 * from an iteration rather than from the pull request.
 */
const RawIterationSchema = Schema.Struct({
  id: Schema.Int,
  createdDate: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(RawIdentitySchema)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  sourceRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  commonRefCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

const RawIterationPageSchema = Schema.Struct({ value: Schema.Array(Schema.Unknown) });

const RawChangeEntrySchema = Schema.Struct({
  changeTrackingId: Schema.optional(Schema.Int),
  changeType: Schema.optional(Schema.NullOr(Schema.String)),
  sourceServerItem: Schema.optional(Schema.NullOr(Schema.String)),
  originalPath: Schema.optional(Schema.NullOr(Schema.String)),
  item: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optional(Schema.NullOr(Schema.String)),
        objectId: Schema.optional(Schema.NullOr(Schema.String)),
        originalObjectId: Schema.optional(Schema.NullOr(Schema.String)),
        isFolder: Schema.optional(Schema.NullOr(Schema.Boolean)),
        gitObjectType: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawChangePageSchema = Schema.Struct({
  changeEntries: Schema.Array(Schema.Unknown),
  nextSkip: Schema.optional(Schema.NullOr(Schema.Number)),
});

const RawItemContentSchema = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  contentMetadata: Schema.optional(
    Schema.NullOr(Schema.Struct({ isBinary: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
});

export interface AzureDevOpsIteration {
  readonly id: number;
  readonly headCommit: string;
  readonly mergeBaseCommit: string;
  readonly update?: PullRequestUpdate;
}

export interface AzureDevOpsChangeEntry {
  readonly changeTrackingId?: number;
  readonly path: string;
  readonly oldPath: string;
  readonly changeKind: "new" | "deleted" | "change" | "rename-pure" | "rename-changed";
  readonly objectId: string | null;
  readonly originalObjectId: string | null;
}

export interface AzureDevOpsChangePage {
  readonly changes: ReadonlyArray<AzureDevOpsChangeEntry>;
  readonly nextSkip: number | null;
}

export interface AzureDevOpsItemContent {
  readonly contents: string;
  readonly isBinary: boolean;
}

const decodeIterationPage = decodeJsonResult(RawIterationPageSchema);
const decodeIterationEntry = Schema.decodeUnknownExit(RawIterationSchema);
const decodeChangePage = decodeJsonResult(RawChangePageSchema);
const decodeChangeEntry = Schema.decodeUnknownExit(RawChangeEntrySchema);
const decodeItemContent = decodeJsonResult(RawItemContentSchema);

/**
 * Azure leads a path with a slash that every other host and every patch omits. Not trimmed like
 * the rest of this payload, since a leading/trailing space is a legal part of a file's name and
 * the patch and viewed mark are keyed by the untrimmed path.
 */
function toRepositoryPath(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const path = value.replace(/^\/+/, "");
  return path.length === 0 ? null : path;
}

function toChangeKind(
  raw: string | null | undefined,
  renamed: boolean,
): AzureDevOpsChangeEntry["changeKind"] {
  const parts = new Set(
    (raw ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  if (parts.has("delete")) return "deleted";
  if (renamed || parts.has("rename")) return parts.has("edit") ? "rename-changed" : "rename-pure";
  if (parts.has("add")) return "new";
  return "change";
}

export function decodeIterationsJson(
  raw: string,
): Result.Result<ReadonlyArray<AzureDevOpsIteration>, DecodeFailure> {
  const decoded = decodeIterationPage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const iterations: AzureDevOpsIteration[] = [];
  for (const entry of decoded.success.value) {
    const decodedIteration = decodeIterationEntry(entry);
    if (Exit.isFailure(decodedIteration)) continue;
    const iteration = decodedIteration.value;
    const headCommit = trimmed(iteration.sourceRefCommit?.commitId);
    const mergeBaseCommit = trimmed(iteration.commonRefCommit?.commitId);
    if (headCommit === null || mergeBaseCommit === null) continue;
    iterations.push({
      id: iteration.id,
      headCommit,
      mergeBaseCommit,
      update: {
        id: iteration.id,
        createdAt: trimmed(iteration.createdDate),
        author: toActor(iteration.author),
        description: iteration.description ?? "",
      },
    });
  }
  return Result.succeed(iterations.toSorted((left, right) => left.id - right.id));
}

export function decodeIterationChangesJson(
  raw: string,
): Result.Result<AzureDevOpsChangePage, DecodeFailure> {
  const decoded = decodeChangePage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const changes: AzureDevOpsChangeEntry[] = [];
  for (const entry of decoded.success.changeEntries) {
    const decodedChange = decodeChangeEntry(entry);
    if (Exit.isFailure(decodedChange)) continue;
    const change = decodedChange.value;
    const path = toRepositoryPath(change.item?.path);
    if (path === null) continue;
    if (change.item?.isFolder === true) continue;
    if ((change.item?.gitObjectType ?? "blob").toLowerCase() !== "blob") continue;
    // Azure names where a renamed file came from in either of two places depending on the route
    // and the version, so both are read and the current path stands in when neither is there.
    const oldPath =
      toRepositoryPath(change.sourceServerItem) ?? toRepositoryPath(change.originalPath) ?? path;
    changes.push({
      ...(change.changeTrackingId === undefined
        ? {}
        : { changeTrackingId: change.changeTrackingId }),
      path,
      oldPath,
      changeKind: toChangeKind(change.changeType, oldPath !== path),
      objectId: trimmed(change.item?.objectId),
      originalObjectId: trimmed(change.item?.originalObjectId),
    });
  }
  const nextSkip = decoded.success.nextSkip ?? null;
  return Result.succeed({
    changes,
    nextSkip: nextSkip !== null && Number.isSafeInteger(nextSkip) && nextSkip > 0 ? nextSkip : null,
  });
}

/**
 * Azure answers an absent file with an empty body rather than an error, which reads as empty.
 * Whether the bytes are text is Azure's own call, not this decoder's to guess from content.
 */
export function decodeItemContentJson(
  raw: string,
): Result.Result<AzureDevOpsItemContent, DecodeFailure> {
  const decoded = decodeItemContent(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({
        contents: decoded.success.content ?? "",
        isBinary: decoded.success.contentMetadata?.isBinary === true,
      })
    : Result.fail(decoded.failure);
}
