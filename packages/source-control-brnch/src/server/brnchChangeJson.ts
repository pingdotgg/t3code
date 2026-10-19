/**
 * What `brnch --json` prints for changes and repositories, and its conversion into the shared
 * change request shapes. Field names follow Brnch's REST API, which the CLI prints as is.
 *
 * @module source-control-brnch/server/brnchChangeJson
 */
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  SourceControlProviderKind,
  TrimmedNonEmptyString,
  type ChangeRequest,
  type PullRequestActor,
  type PullRequestComment,
} from "@t3tools/contracts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import { BRNCH_HOST } from "./brnchCli.ts";

const Actor = Schema.Struct({
  type: Schema.String,
  id: TrimmedNonEmptyString,
  user_id: Schema.NullOr(TrimmedNonEmptyString),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  /** The current handle and full name of the person `user_id` names. */
  handle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  user_name: Schema.optional(Schema.NullOr(Schema.String)),
});
type Actor = typeof Actor.Type;

export const BrnchChange = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  state: Schema.Literals(["draft", "open", "merged", "closed"]),
  target_ref: TrimmedNonEmptyString,
  source: Schema.Struct({
    kind: Schema.String,
    workspace_id: Schema.NullOr(Schema.String),
    ref: Schema.NullOr(Schema.String),
    repository: Schema.optional(
      Schema.NullOr(Schema.Struct({ full_name: Schema.NullOr(TrimmedNonEmptyString) })),
    ),
  }),
  author: Actor,
  current_revision: Schema.Struct({ head_oid: TrimmedNonEmptyString }),
  merged: Schema.NullOr(Schema.Struct({ at: IsoDateTime })),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type BrnchChange = typeof BrnchChange.Type;

export const BrnchChanges = Schema.Struct({
  items: Schema.Array(BrnchChange),
  next_cursor: Schema.NullOr(Schema.String),
});

export const BrnchRepository = Schema.Struct({
  org_slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  default_branch: Schema.NullOr(TrimmedNonEmptyString),
});

const Comment = Schema.Struct({
  id: TrimmedNonEmptyString,
  author: Actor,
  body: Schema.String,
  created_at: IsoDateTime,
  edited_at: Schema.NullOr(IsoDateTime),
});

export const BrnchThreads = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      anchor: Schema.Struct({ path: Schema.NullOr(Schema.String) }),
      comments: Schema.Array(Comment),
    }),
  ),
  next_cursor: Schema.NullOr(Schema.String),
});

/** `brnch change diff` without `--path`: the files a change touches. */
export const BrnchChangeFiles = Schema.Struct({
  files: Schema.Array(Schema.Struct({ new_path: Schema.NullOr(Schema.String) })),
  truncated: Schema.Boolean,
});

export const BrnchPromotion = Schema.Struct({
  state: Schema.String,
  blockers: Schema.Array(Schema.Struct({ message: Schema.String })),
  error: Schema.NullOr(Schema.String),
});

const KIND = SourceControlProviderKind.make("brnch");

/** A branch's short name; Brnch stores refs in full, e.g. `refs/heads/feature`. */
export const branchName = (ref: string) => ref.replace(/^refs\/heads\//u, "");

/** The source branch, or the workspace a change was proposed from, which has none. */
export const headBranch = (change: BrnchChange) =>
  change.source.ref ? branchName(change.source.ref) : (change.source.workspace_id ?? change.id);

export const changeUrl = (repository: string, number: number) =>
  `https://${BRNCH_HOST}/${repository}/changes/${number}`;

/** A fork's change names its source repository; null when the viewer cannot read it. */
const sourceRepository = (change: BrnchChange, repository: string) =>
  change.source.kind === "fork" ? (change.source.repository?.full_name ?? null) : repository;

/**
 * An actor reads under the handle of the person accountable for it, the sponsor for an agent
 * session. A response from before Brnch named actors carries only a user id, which stands in.
 */
/** The handle an actor reads under, which is what the viewer's own handle compares against. */
export const actorLogin = (actor: Actor) => actor.handle ?? actor.user_id ?? actor.id;

function toActor(actor: Actor): PullRequestActor {
  return {
    login: actorLogin(actor),
    name: actor.display_name ?? actor.user_name ?? null,
    avatarUrl: null,
    ...(actor.type === "integration" || actor.type === "service" ? { isBot: true } : {}),
  };
}

export function toChangeRequest(change: BrnchChange, repository: string): ChangeRequest {
  const headRepository = sourceRepository(change, repository);
  return {
    provider: KIND,
    number: change.number,
    title: change.title,
    url: changeUrl(repository, change.number),
    baseRefName: branchName(change.target_ref),
    headRefName: headBranch(change),
    headSha: change.current_revision.head_oid,
    state: change.state === "draft" ? "open" : change.state,
    ...(change.state === "draft" ? { isDraft: true } : {}),
    mergedAt: change.merged?.at ?? null,
    updatedAt: DateTime.make(change.updated_at),
    isCrossRepository: change.source.kind === "fork",
    headRepositoryNameWithOwner: headRepository,
    headRepositoryOwnerLogin: headRepository?.split("/")[0] ?? null,
  };
}

export function toProviderChangeRequest(
  change: BrnchChange,
  repository: string,
): ProviderChangeRequest {
  return {
    number: change.number,
    title: change.title,
    url: changeUrl(repository, change.number),
    author: toActor(change.author),
    headBranch: headBranch(change),
    headRepositoryNameWithOwner: sourceRepository(change, repository),
    baseBranch: branchName(change.target_ref),
    state: change.state === "draft" ? "open" : change.state,
    isDraft: change.state === "draft",
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: change.created_at,
    mergedAt: change.merged?.at ?? null,
    updatedAt: change.updated_at,
    reviewRequestLogins: [],
    labels: [],
  };
}

/**
 * Brnch keeps every remark in a review thread; one anchored to a file is a line comment, and the
 * rest is the change's conversation.
 */
export function toActivity(threads: typeof BrnchThreads.Type): ProviderChangeRequestActivity {
  const comments = threads.items
    .flatMap((thread) =>
      thread.comments.map((comment): PullRequestComment => ({
        id: comment.id,
        kind: thread.anchor.path === null ? "issue-comment" : "review-comment",
        author: toActor(comment.author),
        body: comment.body,
        createdAt: comment.created_at,
        editedAt: comment.edited_at,
        url: null,
        path: thread.anchor.path,
        reviewState: null,
      })),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    comments,
    commentCount: comments.length,
    commentsTruncated: threads.next_cursor !== null,
    reviewThreads: [],
    commits: [],
  };
}
